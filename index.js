const fetch = require('node-fetch');
const crypto = require('crypto');
const { stringify } = require('querystring');
const EventEmitter = require('events');
const newLineRegex = /\S/;
const predicate = (a, b) => {
	if (a[0] < b[0]) return -1;
	if (a[0] > b[0]) return 1;
	return 0;
};

class Client extends EventEmitter {
	constructor(config) {
		super();
		this.restart = typeof config.restart === 'undefined' ? config.restart : true;
		this.consumer_key = config.consumer_key;
		this.consumer_secret = config.consumer_secret;
		this.access_token_key = config.access_token_key;
		this.access_token_secret = config.access_token_secret;
		this.basicAuth = Boolean(this.consumer_key && this.consumer_secret && !this.access_token_key && !this.access_token_secret);
		this.auth = null;
		this._verifyOptions();
	}

	_generateSignature(method, url, params, data) {
		const obj = Object.assign({}, params);
		if (data && typeof data.body !== 'undefined') Object.assign(obj, data.body);
		if (data && typeof data.query !== 'undefined') Object.assign(obj, data.query);

		const sorted = Object.entries(obj).sort(predicate);

		const attr = sorted.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
		const final = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(attr)}`;
		const signKey = `${encodeURIComponent(this.consumer_secret)}&${encodeURIComponent(this.access_token_secret)}`;
		const hash = crypto.createHmac('sha1', signKey).update(final).digest();
		return hash.toString('base64');
	}

	_getToken() {
		const credentials = Buffer.from(`${this.consumer_key}:${this.consumer_secret}`).toString('base64');
		const OAuthURL = 'https://api.twitter.com/oauth2/token';
		const body = stringify({ grant_type: 'client_credentials' });
		return fetch(OAuthURL, {
			method: 'POST',
			body,
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

	async _makeRequest(endpoint, method = 'GET', options) {
		if (!endpoint) throw Error('makeRequest: endpoint required');

		const baseURL = 'https://api.twitter.com/1.1';
		const streamURL = 'https://stream.twitter.com/1.1';
		let url = endpoint === 'statuses/filter' ? `${streamURL}/${endpoint}.json` : `${baseURL}/${endpoint}.json`;

		const callback = r => {
			if (!r.ok) throw Error(r.statusText);
			if (endpoint !== 'statuses/filter') return r.json();
			let data = '';
			r.body
				.on('data', chunk => {
					if (chunk.includes('\n')) {
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
					}
					else data += chunk;
				})
				.once('close', m => {
					if (this.restart) {
						this.emit('error', 'Stream endpoint restarting due to close:', m);
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
				.once('end', () => this.emit('end'));
				return this;
		};

		if (!this.basicAuth) {
			const nonce = ((Math.random() * 1000000) + 5000).toFixed(0);
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
			if (options && typeof options.query !== 'undefined') url += `?${stringify(options.query)}`;

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

		if (method === 'GET') {
			return fetch(url, {
				method,
				headers: {
					'Authorization': this.auth,
					'Content-Type': 'application/json'
				}
			}).then(callback);
		}
		else if (method === 'POST') {
			return fetch(url, {
				method: 'POST',
				headers: {
					'Authorization': this.auth,
					'Content-Type': 'application/x-www-form-urlencoded'
				},
				body: options && options.body ? stringify(options.body) : ''
			}).then(callback);

		}
		else throw Error('makeRequest: only GET/POST methods are supported.');
	}

	get(endpoint, options) {
		return this._makeRequest(endpoint, 'GET', options);
	}

	startStream(options = {}) {
		return this._makeRequest('statuses/filter', 'POST', { body: options })
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
