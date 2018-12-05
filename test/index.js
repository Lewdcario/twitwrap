const config = require('./auth');
const Client = require('../index');
const bot = new Client(config);

bot.startStream({ track: 'twitter' })
	.then(listener => {
		// Listener === bot
		listener.on('event', console.log);
		listener.on('error', console.error);
	});

bot.get('statuses/show/1069968589686562816').then(console.log);

process.on('unhandledRejection', (e) => console.error('[UNHANDLED REJECTION]', e));
