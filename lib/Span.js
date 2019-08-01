"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const EventMessage_1 = require("./model/EventMessage");
const Recorder_1 = require("./Recorder");
const EventLoggingServiceClient_1 = require("./transport/EventLoggingServiceClient");
const _ = require('lodash');
const Config = require('./lib/config');
const defaultRecorder = Config.SIDECAR_DISABLED
    ? new Recorder_1.DefaultLoggerRecorder()
    : new Recorder_1.DefaultSidecarRecorder(new EventLoggingServiceClient_1.EventLoggingServiceClient(Config.EVENT_LOGGER_SERVER_HOST, Config.EVENT_LOGGER_SERVER_PORT));
class Span {
    /**
     * Creates new span. Normally this is not used directly, but by a Tracer.createSpan method
     * @param spanContext context of the new span. Service is obligatory. Depending on the rest provided values, the new span will be created as a parent or child span
     * @param {Recorders} recorders different recorders to be used for different logging methods
     * @param defaultTagsSetter the tags setter method can be passed here
     */
    constructor(spanContext, recorders, defaultTagsSetter) {
        this._finished = false;
        /**
         * Helper function to create event message, based on message and event types, action and state.
         */
        this.createEventMessage = (message, type, _action, state = EventMessage_1.EventStateMetadata.success()) => {
            let defaults = getDefaults(type);
            let action = _action ? _action : defaults.action;
            let messageToLog;
            if (typeof message === 'string') {
                messageToLog = new EventMessage_1.EventMessage({
                    content: { payload: { message } },
                    type
                });
            }
            else if ((typeof message === 'object') && (!(message.hasOwnProperty('content')) || !(message.hasOwnProperty('type')))) {
                messageToLog = new EventMessage_1.EventMessage({
                    content: { payload: { message } },
                    type
                });
            }
            else {
                messageToLog = new EventMessage_1.EventMessage(message);
            }
            return Object.assign(messageToLog, {
                metadata: {
                    event: defaults.eventMetadataCreator({
                        action,
                        state
                    }),
                    trace: this.spanContext
                }
            });
        };
        this.spanContext = Object.freeze(spanContext);
        this.defaultTagsSetter = defaultTagsSetter ? defaultTagsSetter : this.defaultTagsSetter;
        this.recorders = recorders ? recorders : { defaultRecorder };
        this.defaultTagsSetter();
        return this;
    }
    /**
     * A method to set tags by default. Not implemented yet
     * @param message the message which tags will be extracted from
     */
    defaultTagsSetter(message) {
        return this;
    }
    /**
     * Gets trace context from the current span
     */
    getContext() {
        return Object.assign({}, this.spanContext, { tags: JSON.parse(JSON.stringify(this.spanContext.tags)) });
    }
    /**
       * Creates and returns new child span of the current span and changes the span service name
       * @param service the name of the service of the new child span
       * @param recorders the recorders which are be set to the child span. If omitted, the recorders of the parent span are used
       */
    getChild(service, recorders = this.recorders) {
        try {
            if (this._finished)
                throw new Error('Finished trace cannot have a child span');
            let inputTraceContext = this.getContext();
            return new Span(new EventMessage_1.EventTraceMetadata(Object.assign({}, inputTraceContext, {
                service,
                spanId: undefined,
                startTimestamp: undefined,
                parentSpanId: inputTraceContext.spanId
            })), recorders, this.defaultTagsSetter);
        }
        catch (e) {
            throw (e);
        }
    }
    /**
     * Injects trace context into a carrier with optional path.
     * @param carrier any kind of message or other object with keys of type String.
     * @param injectOptions type and path of the carrier. Type is not implemented yet. Path is the path to the trace context.
     */
    injectContextToMessage(carrier, injectOptions = {}) {
        let result = _.cloneDeep(carrier);
        let { path } = injectOptions; // type not implemented yet
        if (carrier instanceof EventMessage_1.EventMessage || (('metadata' in carrier)))
            path = 'metadata';
        else if (carrier instanceof EventMessage_1.EventTraceMetadata)
            return Promise.resolve(this.spanContext);
        if (!path)
            Object.assign(result, { trace: this.spanContext });
        else
            _.merge(_.get(result, path), { trace: this.spanContext });
        return Promise.resolve(result);
    }
    /**
     * Sets tags to the current span. If child span is created, the tags are passed on.
     * @param tags key value pairs of tags. Tags can be changed on different child spans
     */
    setTags(tags) {
        let newContext = new EventMessage_1.EventTraceMetadata(this.getContext());
        for (let key in tags) {
            newContext.tags[key] = tags[key];
        }
        this.spanContext = Object.freeze(new EventMessage_1.EventTraceMetadata(newContext));
        return this;
    }
    /**
    * Finishes the current span and its trace and sends the data to the tracing framework.
    * @param message optional parameter for a message to be passed to the tracing framework.
    * @param finishTimestamp optional parameter for the finish time. If omitted, current time is used.
    */
    finish(message, finishTimestamp) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.spanContext.finishTimestamp)
                return Promise.reject(new Error('span already finished'));
            let spanContext = this._finishSpan(finishTimestamp).getContext();
            yield this.trace(message, spanContext);
            return Promise.resolve(this);
        });
    }
    /**
     * Finishes the trace by adding finish timestamp to the current span.
     * @param finishTimestamp optional parameter for the finish time. If omitted, current time is used.
     */
    _finishSpan(finishTimestamp) {
        let newContext = Object.assign({}, this.spanContext);
        if (finishTimestamp instanceof Date) {
            newContext.finishTimestamp = finishTimestamp.toISOString(); // ISO 8601
        }
        else if (!finishTimestamp) {
            newContext.finishTimestamp = (new Date()).toISOString(); // ISO 8601
        }
        else {
            newContext.finishTimestamp = finishTimestamp;
        }
        this.spanContext = Object.freeze(new EventMessage_1.EventTraceMetadata(newContext));
        return this;
    }
    /**
     * Sends trace message to the tracing framework
     * @param message
     * @param spanContext optional parameter. Can be used to trace previous span. If not set, the current span context is used.
     * @param action optional parameter for action. Defaults to 'span'
     * @param state optional parameter for state. Defaults to 'success'
     */
    trace(message, spanContext = this.spanContext, action, state) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!message)
                message = new EventMessage_1.EventMessage({
                    type: 'trace',
                    content: spanContext
                });
            try {
                yield this.recordMessage(message, EventMessage_1.TraceEventTypeAction.getType(), action, state);
                this._finished = this.spanContext.finishTimestamp ? true : false;
                return this;
            }
            catch (e) {
                throw new Error(`Error when logging trace. ${JSON.stringify(e, null, 2)}`);
            }
        });
    }
    /**
     * Sends audit type message to the event logging framework.
     * @param message message to be recorded as audit event
     * @param action optional parameter for action. Defaults to 'default'
     * @param state optional parameter for state. Defaults to 'success'
     */
    audit(message, action, state) {
        return __awaiter(this, void 0, void 0, function* () {
            let result = yield this.recordMessage(message, EventMessage_1.AuditEventTypeAction.getType(), action, state);
            return result;
        });
    }
    /**
     * Logs INFO type message.
     * @param message if message is a string, the message is added to a message property of context of an event message.
     * If message is not following the event framework message format, the message is added as it is to the context of an event message.
     * If message follows the event framework message format, only the metadata is updated and if message lacks an UUID it is created.
     * @param state optional parameter for state. Defaults to 'success'
     */
    info(message, state) {
        return __awaiter(this, void 0, void 0, function* () {
            let { action, type } = new EventMessage_1.LogEventTypeAction(EventMessage_1.LogEventAction.info);
            yield this.recordMessage(message, type, action, state);
        });
    }
    /**
     * Logs DEBUG type message.
     * @param message if message is a string, the message is added to a message property of context of an event message.
     * If message is not following the event framework message format, the message is added as it is to the context of an event message.
     * If message follows the event framework message format, only the metadata is updated and if message lacks an UUID it is created.
     * @param state optional parameter for state. Defaults to 'success'
     */
    debug(message, state) {
        return __awaiter(this, void 0, void 0, function* () {
            let { action, type } = new EventMessage_1.LogEventTypeAction(EventMessage_1.LogEventAction.debug);
            yield this.recordMessage(message, type, action, state);
        });
    }
    /**
     * Logs VERBOSE type message.
     * @param message if message is a string, the message is added to a message property of context of an event message.
     * If message is not following the event framework message format, the message is added as it is to the context of an event message.
     * If message follows the event framework message format, only the metadata is updated and if message lacks an UUID it is created.
     * @param state optional parameter for state. Defaults to 'success'
     */
    verbose(message, state) {
        return __awaiter(this, void 0, void 0, function* () {
            let { action, type } = new EventMessage_1.LogEventTypeAction(EventMessage_1.LogEventAction.verbose);
            yield this.recordMessage(message, type, action, state);
        });
    }
    /**
     * Logs PERFORMANCE type message.
     * @param message if message is a string, the message is added to a message property of context of an event message.
     * If message is not following the event framework message format, the message is added as it is to the context of an event message.
     * If message follows the event framework message format, only the metadata is updated and if message lacks an UUID it is created.
     * @param state optional parameter for state. Defaults to 'success'
     */
    performance(message, state) {
        return __awaiter(this, void 0, void 0, function* () {
            let { action, type } = new EventMessage_1.LogEventTypeAction(EventMessage_1.LogEventAction.performance);
            yield this.recordMessage(message, type, action, state);
        });
    }
    /**
     * Logs WARNING type message.
     * @param message if message is a string, the message is added to a message property of context of an event message.
     * If message is not following the event framework message format, the message is added as it is to the context of an event message.
     * If message follows the event framework message format, only the metadata is updated and if message lacks an UUID it is created.
     * @param state optional parameter for state. Defaults to 'success'
     */
    warning(message, state) {
        return __awaiter(this, void 0, void 0, function* () {
            let { action, type } = new EventMessage_1.LogEventTypeAction(EventMessage_1.LogEventAction.warning);
            yield this.recordMessage(message, type, action, state);
        });
    }
    /**
     * Logs ERROR type message.
     * @param message if message is a string, the message is added to a message property of context of an event message.
     * If message is not following the event framework message format, the message is added as it is to the context of an event message.
     * If message follows the event framework message format, only the metadata is updated and if message lacks an UUID it is created.
     * @param state optional parameter for state. Defaults to 'success'
     */
    error(message, state) {
        return __awaiter(this, void 0, void 0, function* () {
            let { action, type } = new EventMessage_1.LogEventTypeAction(EventMessage_1.LogEventAction.error);
            yield this.recordMessage(message, type, action, state);
        });
    }
    /**
     * Sends Event message to recorders
     * @param message the Event message that needs to be recorded
     * @param type type of Event
     * @param action optional parameter for action. The default is based on type defaults
     * @param state optional parameter for state. Defaults to 'success'
     */
    recordMessage(message, type, action, state) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._finished)
                throw new Error('span finished. no further actions allowed');
            let newEnvelope = this.createEventMessage(message, type, action, state);
            let logResult;
            let key = `${type}Recorder`;
            if (this.recorders[key])
                logResult = yield this.recorders[key].record(newEnvelope);
            else
                logResult = yield this.recorders.defaultRecorder.record(newEnvelope);
            if (EventMessage_1.LogResponseStatus.accepted == logResult.status) {
                return logResult;
            }
            else {
                throw new Error(`Error when recording ${type}-${action} event. status: ${logResult.status}`);
            }
        });
    }
}
exports.Span = Span;
const getDefaults = (type) => {
    switch (type) {
        case EventMessage_1.EventType.audit: {
            return {
                action: EventMessage_1.AuditEventAction.default,
                eventMetadataCreator: EventMessage_1.EventMetadata.audit
            };
        }
        case EventMessage_1.EventType.trace: {
            return {
                action: EventMessage_1.TraceEventAction.span,
                eventMetadataCreator: EventMessage_1.EventMetadata.trace
            };
        }
        case EventMessage_1.EventType.log: {
            return {
                action: EventMessage_1.LogEventAction.info,
                eventMetadataCreator: EventMessage_1.EventMetadata.log
            };
        }
    }
    return {
        action: EventMessage_1.NullEventAction.undefined,
        eventMetadataCreator: EventMessage_1.EventMetadata.log
    };
};
//# sourceMappingURL=Span.js.map