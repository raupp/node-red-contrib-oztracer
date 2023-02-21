const { context, metrics, propagation, SpanStatusCode, trace } = require('@opentelemetry/api');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { BasicTracerProvider, ConsoleSpanExporter, SimpleSpanProcessor, AlwaysOnSampler, BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');
const fse = require('fs-extra');
const jsondiffpatch = require('jsondiffpatch');
const _ = require('lodash');
const cycle = require('./cycle.js');

const flows = {};
const messagesToTrace = {};

const collectorOptions = {
    url: 'http://mhnet.ozmap.com.br:4318/v1/traces'
};
const oTLPTraceExporter = new OTLPTraceExporter(collectorOptions);
const spanProcessor = new SimpleSpanProcessor(oTLPTraceExporter);

function createTracer(node) {
    let name = node.name || node.label;
    const provider = new BasicTracerProvider({
        generalLimits: {
            attributeValueLengthLimit: 2048,
            attributeCountLimit: 256
        },
        spanLimits: {
            attributeValueLengthLimit: 2048,
            attributeCountLimit: 256,
            linkCountLimit: 256,
            eventCountLimit: 256
        },
        sampler: new AlwaysOnSampler(),
        resource: new Resource({
            [SemanticResourceAttributes.SERVICE_NAME]: name,
        }),
    });
    provider.addSpanProcessor(spanProcessor);
    provider.register();
    return provider.getTracer(name);
}

module.exports = function (RED) {
    const msgTracerConfigFolderPath = path.resolve(RED.settings.userDir, 'msg-tracer-config');
    const msgTracerConfigPath = path.join(msgTracerConfigFolderPath, 'local.json');
    const flowManagerConfig = JSON.parse(JSON.stringify(require('config')));
    const persistFlowManagerConfigFile = async function () {
        await fse.ensureDir(msgTracerConfigFolderPath);
        fs.writeFile(msgTracerConfigPath, JSON.stringify(flowManagerConfig), 'utf8', function () { });
    };

    RED.events.on('flows:started', function () {
        RED.nodes.eachNode(function (node) {
            if (node.type === 'tab' || node.type.startsWith('subflow:')) {
                flows[node.id] = node;
                node.tracer = createTracer(node)
            }
        });
        checkAllParentSpanIsReadyToCloseRecursive();
    });

    function checkAllParentSpanIsReadyToCloseRecursive(){
        for(let msgId in messagesToTrace){ 
            checkIfParentSpanIsReadyToClose(msgId);
        }
        setTimeout(checkAllParentSpanIsReadyToCloseRecursive, 5000);
    }

    function checkIfParentSpanIsReadyToClose(msgId){
        let spans = messagesToTrace[msgId].spans;
        let readyToClose = true;
        for(let spanIdx in spans){ 
            if(spans[spanIdx].active){
                //ainda tem ativos, ignorar;
                readyToClose = false;
                return;
            }
        }
        if(readyToClose){
            messagesToTrace[msgId].parentSpan.setStatus({ code: SpanStatusCode.OK });
            messagesToTrace[msgId].parentSpan.end();
            delete messagesToTrace[msgId];
        }
    }

    function createParentOrSpanBase(tracer, nodeId, msgId, nodeName, flowName, node, msg, sourceNode) {
        if(node.type === 'debug'){
            //se for nó de debug, podemos ignorar;
            return;
        }

        if(node.type === 'split'){
            console.log("Splitter", node, msg)
            msg.ozParentMessageId = msgId;
        }

        if(sourceNode && sourceNode.type === 'split' && msg.ozParentMessageId){
            //É uma mensagem criada por um splitter            
            if (!messagesToTrace[msgId]) {
                messagesToTrace[msgId] = {
                    parentSpan: messagesToTrace[msg.ozParentMessageId].parentSpan,
                    ctx: messagesToTrace[msg.ozParentMessageId].ctx,
                    spans: messagesToTrace[msg.ozParentMessageId].spans
                }
            }
        }

        if (!messagesToTrace[msgId]) {
            let parentSpan = tracer.startSpan(flowName);
            messagesToTrace[msgId] = {
                parentSpan: parentSpan,
                ctx: trace.setSpan(context.active(), parentSpan),
                spans: {}
            }
        }        
        //Criar o Span para este nó
        messagesToTrace[msgId].spans[nodeId] = {
            span: tracer.startSpan(nodeName, flowName, messagesToTrace[msgId]['ctx']),
            active: true
        }

    }


    RED.hooks.add("preRoute", (sendEvents) => {
        let evt = sendEvents;
        let source = evt.source
        let node = source.node;
        let msg = evt.msg;
        let msgId = msg._msgid;
        let flowId = node.z;
        let flow = flows[flowId];
        let tracer = flow.tracer;
        let id = node.id;

        //Somente necessário para pegar o evento que vem do http-in, já que ele não vem de outra mensagem
        if ((node.type === 'http in' || node.type === 'inject')) {
            //Caso a mensagem ainda não tenha trace, criar a base do trace, não tem origim interna, src null
            createParentOrSpanBase(tracer, id, msgId, node.name, flow.name, node, msg, null)
        }

        /**
        

        //criar um span pra este nó
        messagesToTrace[msg._msgid][node.id] = tracer.startSpan(node.name, flow.name, messagesToTrace[msg._msgid]['ctx']);

        //para cada saida nó, vamos criar um span
        if(node.wires.length > 0 ){
            for (let id of node.wires[0]) {
                messagesToTrace[msg._msgid][id] = tracer.startSpan(node.name, flow.name, messagesToTrace[msg._msgid]['ctx']);
            }
        }


        //se for um http-in ou inject, vamos criar o span pai
        if ((node.type === 'http in' || node.type === 'inject')) {
            if (!msg.OZParentSpan) {
                msg.OZParentSpan = tracer.startSpan(flow.name);
            }
            const ctx = trace.setSpan(context.active(), msg.OZParentSpan);
            msg.OZSpan = {};
            for (let id of node.wires[0]) {
                msg.OZSpan[id] = tracer.startSpan(node.name, flow.name, ctx);
                if (msg.req) {
                    msg.OZSpan[id].setAttribute("headers", JSON.stringify(msg.req.headers));
                    msg.OZSpan[id].setAttribute("params", JSON.stringify(msg.req.params));
                    msg.OZSpan[id].setAttribute("query", JSON.stringify(msg.req.query));
                    msg.OZSpan[id].setAttribute("body", JSON.stringify(msg.req.body));
                } else {
                    msg.OZSpan[id].setAttribute("message", JSON.stringify(msg.payload));
                }
            }
        }
            //*/
    });

    RED.hooks.add("postDeliver", (sentEvent) => {
        let msg = sentEvent.msg;
        let msgId = msg._msgid;
        let destination = sentEvent.destination;
        let node = destination.node;
        let flowId = node.z;
        let flow = flows[flowId];
        let tracer = flow.tracer;
        let id = node.id;
        let sourceNode = sentEvent.source.node;
        let sourceId = sourceNode.id

        console.log("postDeliver", node.name, msgId, node.type)

        //Pode ser que a mensagem seja criada no meio do caminho, se este for o caso, vamos
        //tentar ver elas e criar um span
        if(!messagesToTrace[msgId]){
            createParentOrSpanBase(tracer, id, msgId, node.name, flow.name, node, msg, sourceNode);
        }

        //Vamos terminar o span do source se ainda não estiver parado
        let sourceSpan = messagesToTrace[msgId].spans[sourceId];
        if (sourceSpan && sourceSpan.active) {
            sourceSpan.span.setStatus({ code: SpanStatusCode.OK });
            sourceSpan.span.end();
            sourceSpan.active = false;
        }
    });



    RED.hooks.add("onReceive", (receiveEvent) => {
        let msg = receiveEvent.msg;
        let msgId = msg._msgid;
        let destination = receiveEvent.destination;
        let node = destination.node;
        let flowId = node.z;
        let flow = flows[flowId];
        let tracer = flow.tracer;
        let id = node.id;

        console.log("onReceive", id, node.name)

        //Acabamos de receber a mensagem neste nó, vamos criar uma span pra ela se não for nó debug
        
        createParentOrSpanBase(tracer, id, msgId, node.name, flow.name, node, msg, null);


        /**
        console.log(node.name,node.wires, "<--------------");
        
        if (!node.type.startsWith('subflow:') && !node.type.startsWith('link out') && !node.type.startsWith('link in')) {
            if (msg.OZSpan && msg.OZSpan[id]) {
                msg.OZSpan[id].setStatus({ code: SpanStatusCode.OK });
                msg.OZSpan[id].end();
            }
            if (msg.OZParentSpan && node.type !== 'http response') {
                const ctx = trace.setSpan(context.active(), msg.OZParentSpan);
                if(!msg.OZSpan){
                    msg.OZSpan = {};
                }
                if(node.wires.length > 0 ){ //esta ligado a algum outro nó
                    for (let wiresId of node.wires[0]) {
                        msg.OZSpan[wiresId] = tracer.startSpan(node.name, flow.name, ctx);
                    }
                }
            }
            if (msg.OZParentSpan && node.type === 'http response') {
                msg.OZParentSpan.setStatus({ code: SpanStatusCode.OK });
                msg.OZParentSpan.end()
            }
        }
        //*/
    });

    // Example onComplete hook
    RED.hooks.add("onComplete", (completeEvent) => {
        let node = completeEvent.node.node;
        let id = node.id;

        /** 
        if (completeEvent.error) {
            completeEvent.msg.OZSpan[id].setStatus({ code: SpanStatusCode.ERROR });
            completeEvent.msg.OZSpan[id].setAttribute("error-message", completeEvent.error);
            completeEvent.msg.OZSpan[id].end();

            completeEvent.msg.OZParentSpan.setStatus({ code: SpanStatusCode.ERROR });
            completeEvent.msg.OZParentSpan.end()

            completeEvent.msg.OZParentSpan = null;
            completeEvent.msg.OZSpan = null;
        }
        // */

    });
};
