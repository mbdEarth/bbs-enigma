/* jslint node: true */
'use strict';

//	ENiGMA½
var conf			= require('../config.js');
var baseClient		= require('../client.js');
var user			= require('../user.js');
var ServerModule	= require('../server_module.js').ServerModule;

var ssh2			= require('ssh2');
var fs				= require('fs');
var util			= require('util');

exports.moduleInfo = {
	name	: 'SSH',
	desc	: 'SSH Server',
	author	: 'NuSkooler'
};

exports.getModule		= SSHServerModule;

function SSHClient(input, output) {
	baseClient.Client.apply(this, arguments);

	var self = this;

	this.input.on('authentication', function onAuthentication(ctx) {
		console.log('auth: ' + ctx.method);

		if('password' === ctx.method) {
			//	:TODO: Log attempts
			user.authenticate(ctx.username, ctx.password, self, function onAuthResult(err) {
				if(err) {
					ctx.reject();
				} else {
					ctx.accept();
				}
			});
		} else if('publickey' === ctx.method) {
			console.log('pub key path');
		} else if('keyboard-interactive' === ctx.method) {
			ctx.reject(['password']);
			//	:TODO: support this. Allow users to generate a key for use or w/e
		
		/*} else if('keyboard-interactive' === ctx.method) {
			console.log(ctx.submethods);	//	:TODO: proper logging; handle known types, etc.

			ctx.prompt([ { prompt : 'Password: ', echo : false } ], function onPromptResponses(err, responses) {
				console.log(err);
				console.log(responses);
			});*/
		} else {
			ctx.reject();
		}
	});

	this.input.on('ready', function onReady() {
		console.log('Client authenticated');

		self.input.on('session', function onSession(accept, reject) {

		});
	});

	this.input.on('end', function onEnd() {
		self.emit('end');
	});
}

util.inherits(SSHClient, baseClient.Client);

function SSHServerModule() {
	ServerModule.call(this);
}

util.inherits(SSHServerModule, ServerModule);

SSHServerModule.prototype.createServer = function() {
	SSHServerModule.super_.prototype.createServer.call(this);

	//	:TODO: setup all options here. What should the banner, etc. really be????
	var serverConf = {
		privateKey : fs.readFileSync(conf.config.servers.ssh.rsaPrivateKey),
		banner : 'ENiGMA½ BBS SSH Server',
		debug : function onDebug(s) { console.log(s); }
	};

	var server = ssh2.Server(serverConf);
	server.on('connection', function onConnection(conn, info) {
		console.log(info);	//	:TODO: Proper logging
		var client = new SSHClient(conn, conn);
		this.emit('client', client);
	});

	return server;
};