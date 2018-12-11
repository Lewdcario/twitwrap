const fetch = require('node-fetch');
const crypto = require('crypto');
const EventEmitter = require('events');
const { stringify } = require('querystring');

const newLineRegex = /\S/;
const predicate = (a, b) => {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
};
const baseURL = 'https://api.twitter.com/1.1';
const streamURL = 'https://stream.twitter.com/1.1';
const OAuthURL = 'https://api.twitter.com/oauth2/token';

/**
 * Options for a client.
 * @typedef {Object} ClientOptions
 * @property {boolean} [restart=true] Whether or not the client will attempt to automatically restart
 * @property {string} [consumer_key] The consumer key
 * @property {string} [consumer_secret] The consumer secret
 * @property {string} [access_token_key] The access token
 * @property {string} [access_token_secret] The access token secret
 */

class Client extends EventEmitter {
	/**
	 * @param {ClientOptions} config The options for the client
	 */
	constructor(config = {}) {
		super();

		/**
		 * Whether or not the client should automatically attempt to restart
		 * @type {boolean}
		 */
		this.restart = typeof config.restart !== 'undefined' ? config.restart : true;

		/**
		 * The consumer key of the client
		 * @type {string}
		 * @private
		 */
		this.consumer_key = config.consumer_key;

		/**
		 * The consumer secret of the client
		 * @type {string}
		 * @private
		 */
		this.consumer_secret = config.consumer_secret;

		/**
		 * The access token key of the client
		 * @type {string}
		 * @private
		 */
		this.access_token_key = config.access_token_key;

		/**
		 * The access token secret of the client
		 * @type {string}
		 * @private
		 */
		this.access_token_secret = config.access_token_secret;

		/**
		 * Whether or not the client is authenticated with basic authorization (not OAuth)
		 * @type {boolean}
		 */
		this.basicAuth = Boolean(this.consumer_key && this.consumer_secret && !this.access_token_key && !this.access_token_secret);

		/**
		 * The authorization parameter for the client
		 * @type {?string}
		 * @private
		 */
		this.auth = null;

		this._verifyOptions();
	}

	_generateSignature(method, url, params, data = {}) {
		const obj = Object.assign({}, params);
		if (typeof data.body !== 'undefined') Object.assign(obj, data.body);
		if (typeof data.query !== 'undefined') Object.assign(obj, data.query);

		const attr = new URLSearchParams(Object.entries(obj));
		attr.sort();

		const final = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(attr.toString())}`;

		const signKey = `${encodeURIComponent(this.consumer_secret)}&${encodeURIComponent(this.access_token_secret)}`;
		const hash = crypto.createHmac('sha1', signKey).update(final).digest();

		return hash.toString('base64');
	}

	_getToken() {
		const credentials = Buffer.from(`${this.consumer_key}:${this.consumer_secret}`).toString('base64');

		return fetch(OAuthURL, {
			method: 'POST',
			body: stringify({ grant_type: 'client_credentials' }),
			headers: {
				'Authorization': `Basic ${credentials}`,
				'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
			}
		})
			.then(r => r.json())
			.then(b => {
				if (b.access_token) return b.access_token;
				throw Error(b);
			})
	}

	_handleResponse(r, stream) {
		if (!r.ok) throw Error(r.statusText);
		if (!stream) return r.json();
		let data = '';
		r.body
			.on('data', chunk => {
				if (!chunk.includes('\n')) {
					data += chunk;
					return;
				}
				data += chunk;
				const chunks = data.split('\n');
				if (newLineRegex.test(chunks[0])) {
					try {
						const parsed = JSON.parse(chunks[0]);
						this.emit('event', parsed);
					}
					catch (e) {
						this.emit('error', `Error parsing chunk:${chunks[0]}`);
					}
				}
				data = chunks.slice(1).join('\n');
			})
			.once('close', () => {
				if (this.restart) {
					this.emit('error', 'Stream endpoint restarting due to close');
					return this._makeRequest(endpoint, method, options);
				}
				this.emit('error', 'Endpoint closed', m);
			})
			.once('error', e => {
				if (this.restart) {
					this.emit('error', 'Stream endpoint restarting due to error:', e);
					return this._makeRequest(endpoint, method, options);
				}
				this.emit('error', 'Endpoint errored', m);
			})
			.once('end', () => {
				this.emit('debug', 'Stream endpoint closed');
			});

		return this;
	}

	async _makeRequest(endpoint, method = 'GET', options = {}, stream = false) {
		if (!endpoint) throw Error('makeRequest: endpoint required');

		let url = stream ? `${streamURL}/${endpoint}.json` : `${baseURL}/${endpoint}.json`;

		if (!this.basicAuth) {
			const nonce = ((Math.random() * 1000000)).toFixed(0) + ((Math.random() * 1000000)).toFixed(0);
			const timestamp = (Date.now() / 1000).toFixed(0);
			const params = {
				oauth_consumer_key: this.consumer_key,
				oauth_nonce: nonce,
				oauth_signature_method: 'HMAC-SHA1',
				oauth_timestamp: timestamp,
				oauth_token: this.access_token_key,
				oauth_version: '1.0'
			};
			params.oauth_signature = this._generateSignature(method, url, params, options);

			let auth = 'OAuth ';
			const entries = Object.entries(params).sort(predicate);
			for (const [k, v] of entries) {
				auth += `${k}="${encodeURIComponent(v)}", `;
			}
			auth = auth.substring(0, auth.length - 2);

			this.auth = auth;
		}
		else {
			const token = await this._getToken();
			this.auth = `Bearer ${token}`;
		}

		if (typeof options.query !== 'undefined') url += `?${stringify(options.query)}`;

		if (method === 'GET') {
			return fetch(url, {
				method,
				headers: {
					'Authorization': this.auth,
					'Content-Type': 'application/json'
				}
			}).then(r => this._handleResponse(r, stream));
		}
		else if (method === 'POST') {
			return fetch(url, {
				method: 'POST',
				headers: {
					'Authorization': this.auth,
					'Content-Type': 'application/x-www-form-urlencoded'
				},
				body: options && options.body ? stringify(options.body) : ''
			}).then(r => this._handleResponse(r, stream));

		}
		else throw Error('makeRequest: only GET/POST methods are supported.');
	}

	/**
	 * Makes a GET request to twitter with the provided endpoint and options
	 * @param {string} endpoint The endpoint to perform a request to
	 * @param {object} [options={}] Request options to provide
	 * @returns {Promise<object>} The request response object
	 */
	get(endpoint, options = {}) {
		return this._makeRequest(endpoint, 'GET', options);
	}

	/**
	 * Start streaming statuses realtime with the provided options
	 * @param {object} [body={}] Request options to provide
	 * @returns {Promise<this>} The current client instance
	 */
	startStream(body = {}) {
		return this._makeRequest('statuses/filter', 'POST', { body }, true);
	}

	_verifyOptions() {
		if (!this.consumer_key && !this.consumer_secret) {
			throw Error('Missing consumer_key and consumer_secret');
		}
		if (!this.access_token_key && !this.access_token_secret) {
			throw Error('Missing access_token_key and access_token_secret');
		}

	}
};

module.exports = Client;
