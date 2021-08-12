// This is not the final code
// Almost similar to Telegram
// Authorization code is still left to finalise
// Sending and receiving messages is pretty much done but some tweaks are left


const Tp = require('thingpedia');
const Url = require('url');

const Signal = require('signal-node-client').Signal;
const FormData = require('form-data');

// encryption
function rot13(x) {
    return Array.prototype.map.call(x, (ch) => {
        var code = ch.charCodeAt(0);
        if (code >= 0x41 && code <= 0x5a)
            code = (((code - 0x41) + 13) % 26) + 0x41;
        else if (code >= 0x61 && code <= 0x7a)
            code = (((code - 0x61) + 13) % 26) + 0x61;

        return String.fromCharCode(code);
    }).join('');
}

const CONSUMER_KEY = process.env['signal_CONSUMER_KEY'] || 'VZRViA2T4qy7CBZjU5juPumZN';
// signal uses OAuth 1.0, so this needs to be here...
const CONSUMER_SECRET = process.env['signal_CONSUMER_SECRET'] || rot13('hsTCqM6neIt3hqum6zvnDCIqQkUuyWtSjKBoqZFONvzVXfb7OJ');

function makeSignalApi(engine, accessToken, accessTokenSecret) {
    var origin = engine.platform.getOrigin();
    return new Signal({
        consumerKey: CONSUMER_KEY,
        consumerSecret: CONSUMER_SECRET,
        callBackUrl: origin + '/devices/oauth2/callback/com.signal',
        accessToken: accessToken,
        accessTokenSecret: accessTokenSecret
    });
}

function runOAuthStep1(engine) {
    let signal = makeSignalApi(engine);

    return new Promise((callback, errback) => {
        signal.oauth.getOAuthRequestToken((error, oauth_token, oauth_token_secret, query) => {
            if (error)
                errback(error);
            else
                callback({ token: oauth_token, tokenSecret: oauth_token_secret, query: query });
        });
    }).then((result) => {
        const url = Url.parse('https://api.signal.com/oauth/authorize');
        url.query = result.query;
        url.query['oauth_token'] = result.token;
        url.query['oauth_token_secret'] = result.tokenSecret;
        return [Url.format(url), { 'signal-token': result.token,
                                   'signal-token-secret': result.tokenSecret }];
    });
}

function runOAuthStep2(engine, req) {
    let signal = makeSignalApi(engine);

    return new Promise((callback, errback) => {
        const token = req.session['signal-token'];
        const tokenSecret = req.session['signal-token-secret'];
        const verifier = req.query['oauth_verifier'];

        signal.oauth.getOAuthAccessToken(token, tokenSecret, verifier, (error, oauth_access_token, oauth_access_token_secret, results) => {
            if (error)
                errback(error);
            else
                callback({ accessToken: oauth_access_token, accessTokenSecret: oauth_access_token_secret });
        });
    }).then((result) => {
        signal = makesignalApi(engine, result.accessToken, result.accessTokenSecret);
        return new Promise((callback, errback) => {
            signal.getCustomApiCall('/account/verify_credentials.json', {}, errback, callback);
        });
    }).then((result) => {
        result = JSON.parse(result);
        return engine.devices.loadOneDevice({ kind: 'com.signal',
                                              accessToken: signal.accessToken,
                                              accessTokenSecret: signal.accessTokenSecret,
                                              userId: result['id_str'],
                                              screenName: result['screen_name'] }, true);
    });
}

// a fixed version of postCustomApiCall that does not append
// the parameters to the url (which would break OAuth)
function postCustomApiCall(url, params, error, success) {
    url = this.baseUrl + url;
    this.doPost(url, params, error, success);
}


module.exports = class SignalAccountDevice extends Tp.BaseDevice {
    static runOAuth2(engine, req) {
        return Promise.resolve().then(() => {
            if (req === null)
                return runOAuthStep1(engine);
            else
                return runOAuthStep2(engine, req);
        }).catch((e) => {
            console.log(e);
            console.log(e.stack);
            throw e;
        });
    }

    constructor(engine, state) {
         super(engine, state);
         // constructor
    }

    // other methods of device class

    //for reading messages
    _pollDirectMessages(since_id) {
        return new Promise((callback, errback) => {
            if (since_id !== undefined)
                this._signal.getCustomApiCall('/direct_messages/events/list.json', { since_id: since_id, count: 20 }, errback, callback);
            else
                this._signal.getCustomApiCall('/direct_messages/events/list.json', { count: 20 }, errback, callback);
        }).then((results) => Promise.all(JSON.parse(results).events.map((dm) => {
            console.log(JSON.stringify(dm));
            return this._pollUserScreenName(dm.message_create.sender_id).then((screen_name) => {
                return {
                    sender: screen_name,
                    message: dm.message_create.message_data.text
                };
            });
        }))).then((results) => results.filter((dm) => dm.sender.toLowerCase() !== this.screenName.toLowerCase()));
    }

    get_direct_messages(params, filters) {
        return this._pollDirectMessages(undefined);
    }

    //for sending messages
    do_send_direct_message({ to, message }) {
        return new Promise((callback, errback) => {
            this._pollUserId(String(to)).then((user_id) => {
                if (!user_id)
                    throw new Error('User not found');
                const data = {
                    event: {
                        type: 'message_create',
                        message_create: {
                            target: { recipient_id: user_id },
                            message_data: { text: String(message) }
                        }
                    }
                };
                this._signal.oauth.post(this._signal.baseUrl + '/direct_messages/events/new.json',
                    this._signal.accessToken,
                    this._signal.accessTokenSecret,
                    JSON.stringify(data),
                    "application/json",
                    (err, body, response) => {
                        if (!err && response.statusCode === 200)
                            callback(body);
                        else
                            errback(err, response, body);
                    });
            });
        }).catch((e) => {
            if (e.message && (!e.data && !e.errors))
                throw e;

            console.error('Failed to send direct message', e);
            if (e.data && e.data)
                throw new Error(JSON.parse(e.data).errors[0].message);
            else if (e.errors)
                throw new Error(e.errors[0].message);
            else
                throw new Error(String(e));
        });
    }
};