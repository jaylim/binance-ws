const EventEmitter = require("events");
const log = require('debug')('binance-ws');
const WebSocket = require('ws');
const axios = require('axios');
const _ = require('lodash');

const { State } = require('bitstatejs');

log.log = console.log.bind(console);

let snapshotUrl = 'https://www.binance.com/api/v1/depth';
let streamUrl = 'wss://stream.binance.com:9443/ws';
let orderBook = {};
let event = {
    depthUpdate,
    updateBook
};
let buffer  = {};
let storage = {};

let CONN = Symbol('conn');
// from the least significant bit
// bit 1: instance is ready
let ST = Symbol('state');
const STATE = { READY : 0x1 };


class Binance extends EventEmitter {
    constructor() {
        super();
        this[ST] = new State();
        this.setMaxListeners(100);

        init.call(this, conn => {
            this[ST].add(STATE.READY);
            this[CONN]   = conn;

            let assets = _.keys(orderBook);
            log('Initialize assets', assets);
            if (assets.length > 0) {
                sendMessage(conn, assets, 'SUBSCRIBE', _.map(assets, asset => [asset.toLowerCase(), 'depth'].join('@')));
            }

            this.emit('init');
        });
    }

    get isReady() {
        return this[ST].has(STATE.READY);
    }

    get state() {
        return this[ST].state;
    }

    get orderBook() {
        return orderBook;
    }

    get listSubscriptions() {
        let conn = this[CONN];

        return new Promise((success) => {
            sendMessage(conn, '', 'LIST_SUBSCRIPTIONS', null, success);
        });
    }

    subscribe(asset) {
        let conn = this[CONN];

        asset = asset.toLowerCase();
        if (asset in orderBook) {
            return ;
        }

        sendMessage(conn, asset, 'SUBSCRIBE', [
            [asset.toLowerCase(), 'depth'].join('@')
        ]);
    }

    unsubscribe(asset) {
        let conn = this[CONN];

        asset = asset.toLowerCase();
        if (!(asset in orderBook)) {
            return ;
        }

        sendMessage(conn, asset, 'UNSUBSCRIBE', [
            [asset.toLowerCase(), 'depth'].join('@')
        ]);
    }
}

function init(handle) {
    connectWs.call(this, () => {
        log('Connection closed. Re-initialised connection.');
        // call back the init() function.
        init.call(this, handle);
    })
    .then(handle);
}

function connectWs(onClose) {
    let url = streamUrl;

    return new Promise((success) => {
        let conn = new WebSocket(url);

        conn.on('open', () => {
            log(`Successfully connect to ${url} stream.`);
            success(conn);
        });

        conn.on('message', msg => {
            let response = JSON.parse(msg);
            if ('id' in response) {
                handleResponse.call(this, response);
            } else if ('e' in response) {
                let { e : name } = response;
                log(`Receive message from event ${name}`);
                if (name in event) {
                    event[name].call(this, response);
                } else {
                    log(`Unsupported event ${name}`);
                }
            } else {
                log(`Unsupported message received.`);
            }
        });

        conn.on('close', onClose);
    });
}

function handleResponse(response) {
    let { id } = response;
    if (!(id in storage)) {
        log(`Request ${id} not found.`);
        return ;
    }

    let item = storage[id], { asset, request : { method } } = item;
    item.response = response;
    if (method == 'SUBSCRIBE') {
        log(`Method ${method}: OK`);
        if (_.isArray(asset)) {
            let p = _.map(asset, a => fetchSnapshot.call(this, a));
            Promise.all(p).then(() => delete storage[id]);
        } else {
            fetchSnapshot.call(this, asset).then(() => delete storage[id]);
        }
    } else if (method == 'UNSUBSCRIBE') {
        log(`Method ${method}: OK`);
        buffer[asset].push(['kill', 0]);
        delete storage[id];
    } else if (typeof item.handle == 'function') {
        item.handle.call(null, response);
        delete storage[id];
    } else {
        log(`Unsupported method ${method}`);
        delete storage[id];
    }
}

function fetchSnapshot(asset) {
    let params = [
        ['symbol', asset.toUpperCase()].join('='),
        ['limit', 1000].join('='),
    ].join('&');
    let url = [snapshotUrl, params].join('?');
    return axios.get(url)
    .then(resp => {
        log(`snapshot ${asset}: OK`);
        orderBook[asset] = resp.data;
        orderBook[asset].lastUpdate = Date.now();
        processBuffer.call(this, asset).call(null);
        log(`Start buffer ${asset}`);

        return asset;
    })
    .catch(err => {
        console.error(`Snapshot asset ${asset} failed.`);
        console.error(err);
    });
}

function processBuffer(asset) {
    return () => {
        let b = buffer[asset] = buffer[asset] || [];
        if (b.length == 0) {
            setTimeout(processBuffer.call(this, asset), 0);
            return ;
        }

        let [[name, data]] = _.pullAt(b, [0]);

        if (name == 'kill') {
            log(`Stopping buffer ${asset}`);
            delete buffer[asset];
            delete orderBook[asset];
            return ;
        }

        if (name in event) {
            log(`Processing ${name}`);
            event[name].call(this, data);
        } else {
            log(`Unsupported event ${name}`);
        }

        setTimeout(processBuffer.call(this, asset), 0);
    }
}

function sendMessage(conn, asset, method, params, handle) {
    let id = Date.now(), request = {
        method,
        params,
        id
    };
    storage[id] = { id, asset, request, response : null, handle };
    conn.send(JSON.stringify(request));
}

function depthUpdate(data) {
    let { s : asset } = data;

    asset = asset.toLowerCase();
    let buff = buffer[asset] = buffer[asset] || [];
    log(`Push updateBook event into buffer[${asset}]`);
    buff.push(['updateBook', data]);
}

function updateBook(data) {
    let { E, s, U, u, b : bids, a : asks } = data;
    s = s.toLowerCase();
    let book = orderBook[s] = orderBook[s] || { lastUpdateId : 0, bids : [], asks : [], lastUpdate : Date.now() };

    // drop due to old event
    if (u <= book.lastUpdateId) {
        return ;
    }

    updateOrderBook(book, bids, asks);

    book.lastUpdateId = u;
    book.lastUpdate   = Date.now();
    this.emit('update', s);
    this.emit(s);
}

function updateOrderBook(book, bids, asks) {
    _.each(bids, _process('bids'));
    _.each(asks, _process('asks'));

    book.bids = _.orderBy(book.bids, [_iteratee], ['desc']);
    book.asks = _.orderBy(book.asks, [_iteratee], ['asc']);

    function _process(type) {
        let list = book[type];
        return ([price, qty]) => {
            let idx = _.findIndex(list, ([_price, _qty]) => _price == price);
            let q   = +qty;
            if (idx == -1) {
                if (q > 0) {
                    list.push([price, qty]);
                }
            } else {
                list[idx][1] = qty;

                if (_.toNumber(list[idx][1]) == 0) {
                    _.pullAt(list, [idx]);
                }
            }
        }
    }

    function _iteratee([price]) {
        return _.toNumber(price);
    }
}

let instance;

exports = module.exports = Binance;
exports.instance = () => {
    if (instance) {
        return instance;
    }
    return instance = new Binance();
}
