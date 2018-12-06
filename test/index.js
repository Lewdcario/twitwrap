const config = require('./auth');
const Client = require('../index');
const bot = new Client({
	consumer_key: config.consumer_key,
	consumer_secret: config.consumer_secret,
	access_token_key: config.access_token_key,
	access_token_secret: config.access_token_secret
});

bot.startStream({ track: 'twitter' })
	.then(listener => {
		// Listener === bot
		listener
			.on('event', console.log)
			.on('error', console.error)
			.on('end', () => console.log('Stream ended'));
	});

bot.get('statuses/show/1069968589686562816').then(console.log);

process.on('unhandledRejection', (e) => console.error('[UNHANDLED REJECTION]', e));
