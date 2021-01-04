const assert  = require('assert');
const Binance = require('..');

describe('Binance', () => {
    let b = Binance.instance();

    it('is instance of Binance', () => assert.ok(b instanceof Binance));

    it('is ready', done => {
        if (b.isReady) {
            done();
        } else {
            b.on('init', () => {
                it('is ready', () => assert.ok(b.isReady));
                done();
            });
        }
    });

    describe('Test subscription', () => {
        it('subscribe LINK/USDT', done => {
            b.subscribe('LINKUSDT');

            b.listSubscriptions.then(resp => {
                assert.ok(resp.result.indexOf('linkusdt@depth') >= 0);
                done();
            })
            .catch(err => {
                done(err);
            });
        });

        it('LINK/USDT orderBook', done => {
            setTimeout(() => {
                try {
                    assert.ok('linkusdt' in b.orderBook);
                    done();
                } catch (err) {
                    done(err);
                }
            }, 1000);
        });

        it('unsubscribe LINK/USDT', done => {
            b.unsubscribe('LINKUSDT');

            b.listSubscriptions.then(resp => {
                assert.ok(resp.result.indexOf('linkusdt@depth') == -1);
                done();
            })
            .catch(err => {
                done(err);
            });
        });
    });
});
