import { fiberizeChildren } from "./createElement";
import { extend, options, typeNumber, emptyObject, isFn, returnFalse, returnTrue, clearArray } from "../src/util";
import { drainQueue, enqueueUpdater } from "./scheduler";
import { pushError, captureError } from "./ErrorBoundary";
import { Refs } from "./Refs";
function alwaysNull() {
    return null;
}
const support16 = true;
const errorType = {
    0: "undefined",
    2: "boolean",
    3: "number",
    4: "string",
    7: "array"
};
/**
 * 为了防止污染用户的实例，需要将操作组件虚拟DOM与生命周期钩子的逻辑全部抽象到这个类中
 *
 * @export
 * @param {any} instance
 * @param {any} vnode
 */
export function CompositeUpdater(vnode, parentContext) {
    var { type, props } = vnode;
    if (!type) {
        throw vnode;
    }
    this.name = type.displayName || type.name;
    this.props = props;
    this.vnode = vnode;
    this.context = getContextByTypes(parentContext, type.contextTypes);
    this.parentContext = parentContext;
    this._pendingCallbacks = [];
    this._pendingStates = [];
    this._jobs = [];
    this._mountOrder = Refs.mountOrder++;
    // update总是保存最新的数据，如state, props, context, parentContext, parentVnode
    //  this._hydrating = true 表示组件会调用render方法及componentDidMount/Update钩子
    //  this._nextCallbacks = [] 表示组件需要在下一周期重新渲染
    //  this._forceUpdate = true 表示会无视shouldComponentUpdate的结果
}

CompositeUpdater.prototype = {
    addJob: function(newJob) {
        var jobs = this._jobs;
        if (jobs[jobs.length - 1] !== newJob) {
            jobs.push(newJob);
        }
    },
    exec(updateQueue) {
        var job = this._jobs.shift();
        if (job) {
            this[job](updateQueue);
        }
    },
    enqueueSetState(state, cb) {
        if (state === true) {
            //forceUpdate
            this._forceUpdate = true;
        } else {
            //setState
            this._pendingStates.push(state);
        }

        if (this._hydrating) {
            //组件在更新过程（_hydrating = true），其setState/forceUpdate被调用
            //那么会延期到下一个渲染过程调用
            if (!this._nextCallbacks) {
                this._nextCallbacks = [cb];
            } else {
                this._nextCallbacks.push(cb);
            }
            return;
        } else {
            if (isFn(cb)) {
                this._pendingCallbacks.push(cb);
            }
        }
        if (options.async) {
            //在事件句柄中执行setState会进行合并
            enqueueUpdater(this);
            return;
        }
        if (this.isMounted === returnTrue) {
            if (this._receiving) {
                //componentWillReceiveProps中的setState/forceUpdate应该被忽略
                return;
            }
            this.addJob("hydrate");
            drainQueue([this]);
        }
    },
    mergeStates() {
        let instance = this.instance,
            pendings = this._pendingStates,
            n = pendings.length,
            state = instance.state;
        if (n === 0) {
            return state;
        }
        let nextState = extend({}, state); //每次都返回新的state
        for (let i = 0; i < n; i++) {
            let pending = pendings[i];
            if (pending && pending.call) {
                pending = pending.call(instance, nextState, this.props);
            }
            extend(nextState, pending);
        }
        pendings.length = 0;
        return nextState;
    },

    isMounted: returnFalse,
    init(updateQueue) {
        let { props, context, vnode } = this;
        let type = vnode.type,
            isStateless = vnode.vtype === 4,
            instance,
            mixin;
        //实例化组件
        try {
            var lastOwn = Refs.currentOwner;
            if(isStateless){
                instance = {
                    refs: {},
                    __proto__: type.prototype,
                    render: function() {
                        return type(this.props, this.context);
                    }
                };
                Refs.currentOwner = instance;
                mixin = type(props, context);
            }else{
                instance =  new type(props, context);
                Refs.currentOwner = instance;
            }
        } catch (e) {
            //失败时，则创建一个假的instance
            instance = {
                updater: this
            };
            vnode.stateNode = instance;
            this.instance = instance;
            return pushError(
                instance,
                "constructor",
                e
            );
        } finally {
            Refs.currentOwner = lastOwn;
        }
        if (isStateless) {
            if (mixin && mixin.render) {
                //支持module pattern component
                extend(instance, mixin);
            } else {
                instance.__isStateless = true;
                vnode.child = mixin;
                this.mergeStates = alwaysNull;
                this.willReceive = false;
            }
        }

        vnode.stateNode = this.instance = instance;
        //如果没有调用constructor super，需要加上这三行
        instance.props = props;
        instance.context = context;
        instance.updater = this;

        if (instance.componentWillMount) {
            captureError(instance, "componentWillMount", []);
            instance.state = this.mergeStates();
        }
        //让顶层的元素updater进行收集
        this.render(updateQueue);
    },

    hydrate(updateQueue) {
        let { instance, context, props, vnode, pendingVnode } = this;
       
        let state = this.mergeStates();
        let shouldUpdate = true;
        if (!this._forceUpdate && !captureError(instance, "shouldComponentUpdate", [props, state, context])) {
            shouldUpdate = false;
            if (pendingVnode) {
                this.vnode = pendingVnode;
                delete this.pendingVnode;
            }
        } else {
            captureError(instance, "componentWillUpdate", [props, state, context]);
            var { props: lastProps, state: lastState } = instance;
            this._hookArgs = [lastProps, lastState];
        }
        vnode.stateNode = instance;
        delete this._forceUpdate;
        //既然setState了，无论shouldComponentUpdate结果如何，用户传给的state对象都会作用到组件上
        instance.props = props;
        instance.state = state;
        instance.context = context;
        if (shouldUpdate) {
            this.render(updateQueue);
        }
        this.addJob("resolve");
        updateQueue.push(this);
    },
    render(updateQueue) {

        let { vnode, pendingVnode, instance, parentContext } = this,
            nextChildren = emptyObject,
            lastChildren = emptyObject,
            childContext = parentContext,
            rendered,
            number;

        if (pendingVnode) {
            vnode = this.vnode = pendingVnode;
            delete this.pendingVnode;
        }
        this._hydrating = true;

        if (this.willReceive === false) {
            rendered = vnode.child;
            delete this.willReceive;
        } else {
            let lastOwn = Refs.currentOwner;
            Refs.currentOwner = instance;

            rendered = captureError(instance, "render", []);
    
            if (instance._hasError) {
                rendered = true;
            }
            Refs.currentOwner = lastOwn;
        }
        number = typeNumber(rendered);
        var hasMounted = this.isMounted();
        if (hasMounted) {
            lastChildren = this.children;
        }
        if (number > 2) {
            if (number > 5) {
                //array, object
                childContext = getChildContext(instance, parentContext);
            }
            nextChildren = fiberizeChildren(rendered, this);
        } else {
            //undefinded, null, boolean
            this.children = nextChildren; //emptyObject
            delete this.child;

        }
        var noSupport = !support16 && errorType[number];
        if (noSupport) {
            pushError(instance, "render", new Error("React15 fail to render " + noSupport));
        }
     
        options.diffChildren(lastChildren, nextChildren, vnode, childContext, updateQueue);
      
    },
    //此方法用于处理元素ref, ComponentDidMount/update钩子，React Chrome DevTools的钩子， 组件ref, 及错误边界
    resolve(updateQueue) {
        let {instance, _hasCatch, vnode} = this;
        let hasMounted = this.isMounted();
        if(!hasMounted){
            this.isMounted = returnTrue;
        }       
        vnode.hasMounted = true;
        if (this._hydrating) {
            let hookName = hasMounted ? "componentDidUpdate" : "componentDidMount";
            captureError(instance, hookName, this._hookArgs || []);
            //执行React Chrome DevTools的钩子
            if (hasMounted) {
                options.afterUpdate(instance);
            } else {
                options.afterMount(instance);
            }
            delete this._hookArgs;
            delete this._hydrating;
        }

        if (_hasCatch) {
            delete this._hasCatch;
            instance._hasTry = true;
            //收集它上方的updater,强行结束它们
            var p = vnode.return;
            do {
                if (p.vtype > 1) {
                    var u = p.stateNode.updater;
                    u.addJob("resolve");
                    updateQueue.push(u);
                }
            } while ((p = p.return));
            this._hydrating = true; //让它不要立即执行，先执行其他的
            instance.componentDidCatch.apply(instance, _hasCatch);
            this._hydrating = false;
        } else {
            //执行组件ref（发生错误时不执行）
            if (vnode._hasRef) {
                Refs.fireRef(vnode, instance.__isStateless ? null : instance);
                vnode._hasRef = false;
            }
            clearArray(this._pendingCallbacks).forEach(function(fn) {
                fn.call(instance);
            });
        }
        var cbs = this._nextCallbacks,
            cb;
        if (cbs && cbs.length) {
            //如果在componentDidMount/Update钩子里执行了setState，那么再次渲染此组件
            do {
                cb = cbs.shift();
                if (isFn(cb)) {
                    this._pendingCallbacks.push(cb);
                }
            } while (cbs.length);
            delete this._nextCallbacks;
            this.addJob("hydrate");
            updateQueue.push(this);
        }
    },
    dispose() {
        var instance = this.instance;
        options.beforeUnmount(instance);
        instance.setState = instance.forceUpdate = returnFalse;
        var vnode = this.vnode;
        Refs.fireRef(vnode, null);
        captureError(instance, "componentWillUnmount", []);
        //在执行componentWillUnmount后才将关联的元素节点解绑，防止用户在钩子里调用 findDOMNode方法
        this.isMounted = returnFalse;
        this._disposed = true;
        delete vnode.child;
    }
};

export function getChildContext(instance, parentContext) {
    if (instance.getChildContext) {
        let context = instance.getChildContext();
        if (context) {
            parentContext = Object.assign({}, parentContext, context);
        }
    }
    return parentContext;
}

export function getContextByTypes(curContext, contextTypes) {
    let context = {};
    if (!contextTypes || !curContext) {
        return context;
    }
    for (let key in contextTypes) {
        if (contextTypes.hasOwnProperty(key)) {
            context[key] = curContext[key];
        }
    }
    return context;
}

/**
 *   元素： 元素虚拟DOM产生updater, 放入列队
 *         插入其孩子的所有DOM， 收集孩子中的组件updater， resolve
 *   组件： 元素虚拟DOM产生instance与updater, 执行 willMount,
 *         立即调用render，目的是能让子级组件立即 willMount
 *   <App /> ==> <p ref={refFn}>{this.state.xxx}</p>
 *  container
 * 
 * 
 *  元素的render，用于添加子节点，收集它们的updater
 *  元素的resolve, 用于设置属性与可控属性，执行它们的ref
 * 
 *  组件的render， 用于执行它们的render, diffChildren 
 *  元素的resolve, 执行生命周期钩子与ref与处理异常
 * 
 *  <App><A /><A /><span>xxx</span></App>
 * 
 *   children.forEach(function(){ el.render() })
 *   children.
 * 
 *   VNode.prototype.render = function(p, queue){
 *      var el = this
 *      if(el.vtype < 1){
 *          el.stateNode = toDOM(el, p)
 *       }else if(el.vtype === 1){
 *          el.stateNode = toDOM(el, p)
 *          for(var i in children){
 *            var a = children[i]
 *            a.render(el, queue)
 *          }
 *          queue.push(el)
 *       } else {
 *          var c = el.stateNode = toComponent(el, p, queue)
 *          el.render() //组件
 *          queue.push(el.updater)
 *       }
 *   }
 *   Vnode.prototype.append = function(parentNode){
 *      var p = this.stateNode, children = this.children
 *      if(this.vtype === 1){
 *          for(var i in children){
 *              var el = children[i]
 *              if(el.vtype < 1){
 *                 p.appendChild(el.stateNode)
 *                
 *              }else if(el.vtype === 1){
 * 
 *                  el.append(p)
 *                  el.resolve()
 *              }else if(el.vtype > 1){
 *                 el.append(p)
 *                 el.resolve()
 *              }
 *          }
 *      }
 *    }
 *    
 *   
 * 
 */