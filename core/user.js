/* jslint node: true */
'use strict';

var userDb			= require('./database.js').dbs.user;
var Config			= require('./config.js').config;
var userGroup		= require('./user_group.js');

var crypto			= require('crypto');
var assert			= require('assert');
var async			= require('async');
var _				= require('lodash');

exports.User						= User;
exports.getUserIdAndName			= getUserIdAndName;

function User() {
	var self = this;

	this.userId		= 0;
	this.username	= '';
	this.properties	= {};	//	name:value
	this.groups		= {};	//	id:name

	this.isValid = function() {
		if(self.userId <= 0 || self.username.length < Config.users.usernameMin) {
			return false;
		}

		return this.hasValidPassword();
	};

	this.hasValidPassword = function() {
		if(!this.properties || !this.properties.pw_pbkdf2_salt || !this.properties.pw_pbkdf2_dk) {
			return false;
		}

		return this.properties.pw_pbkdf2_salt.length === User.PBKDF2.saltLen * 2 &&
			this.prop_name.pw_pbkdf2_dk.length === User.PBKDF2.keyLen * 2;
	};

	this.isRoot = function() {
		return 1 === this.userId;
	};

	this.isSysOp = this.isRoot;	//	alias

	this.isGroupMember = function(groupIdOrName) {
		return _.isString(self.groups[groupIdOrName]);
	};

}

User.PBKDF2 = {
	iterations	: 1000,
	keyLen		: 128,
	saltLen		: 32,
};

User.StandardPropertyGroups = {
	password	: [ 'pw_pbkdf2_salt', 'pw_pbkdf2_dk' ],
};

User.AccountStatus = {
	disabled	: -1,
	inactive	: 0,
	active		: 1,
};

User.prototype.authenticate = function(username, password, cb) {
	var self = this;

	var cachedInfo = {};

	async.waterfall(
		[
			function fetchUserId(callback) {
				//	get user ID
				getUserIdAndName(username, function onUserId(err, uid, un) {
					cachedInfo.userId	= uid;
					cachedInfo.username	= un;

					callback(err);
				});
			},

			function getRequiredAuthProperties(callback) {
				//	fetch properties required for authentication
				loadProperties( { userId : cachedInfo.userId, names : User.StandardPropertyGroups.password }, function onProps(err, props) {
					callback(err, props);
				});
			},
			function getDkWithSalt(props, callback) {
				//	get DK from stored salt and password provided
				generatePasswordDerivedKey(password, props.pw_pbkdf2_salt, function onDk(err, dk) {
					callback(err, dk, props.pw_pbkdf2_dk);
				});
			},
			function validateAuth(passDk, propsDk, callback) {
				//
				//	Use constant time comparison here for security feel-goods
				//
				var passDkBuf	= new Buffer(passDk,	'hex');
				var propsDkBuf	= new Buffer(propsDk,	'hex');

				if(passDkBuf.length !== propsDkBuf.length) {
					callback(new Error('Invalid password'));
					return;
				}

				var c = 0;
				for(var i = 0; i < passDkBuf.length; i++) {
					c |= passDkBuf[i] ^ propsDkBuf[i];
				}

				callback(0 === c ? null : new Error('Invalid password'));
			},
			function initProps(callback) {
				loadProperties( { userId : cachedInfo.userId }, function onProps(err, allProps) {
					if(!err) {
						cachedInfo.properties = allProps;
					}

					callback(err);
				});
			},
			function initGroups(callback) {
				userGroup.getGroupsForUser(cachedInfo.userId, function groupsLoaded(err, groups) {
					if(!err) {
						cachedInfo.groups = groups;
					}

					callback(err);
				});
			}
		],
		function complete(err) {
			if(!err) {
				self.userId			= cachedInfo.userId;
				self.username		= cachedInfo.username;
				self.properties		= cachedInfo.properties;
				self.groups			= cachedInfo.groups;
				self.authenticated	= true;
			}

			cb(err);
		}
	);
};

User.prototype.create = function(options, cb) {
	assert(0 === this.userId);
	assert(this.username.length > 0);	//	:TODO: Min username length? Max?
	assert(_.isObject(options));
	assert(_.isString(options.password));

	var self = this;

	//	:TODO: set various defaults, e.g. default activation status, etc.
	self.properties.account_status = Config.users.requireActivation ? User.AccountStatus.inactive : User.AccountStatus.active;

	async.series(
		[
			function beginTransaction(callback) {
				userDb.run('BEGIN;', function transBegin(err) {
					callback(err);
				});
			},
			function createUserRec(callback) {
				userDb.run(
					'INSERT INTO user (user_name) ' +
					'VALUES (?);',
					[ self.username ],
					function userInsert(err) {
						if(err) {
							callback(err);
						} else {
							self.userId = this.lastID;

							//	Do not require activation for userId 1 (root/admin)
							if(1 === self.userId) {
								self.properties.account_status = User.AccountStatus.active;
							}



							callback(null);
						}
					}
				);
			},
			function genAuthCredentials(callback) {
				generatePasswordDerivedKeyAndSalt(options.password, function dkAndSalt(err, info) {
					if(err) {
						callback(err);
					} else {
						self.properties.pw_pbkdf2_salt	= info.salt;
						self.properties.pw_pbkdf2_dk	= info.dk;
						callback(null);
					}
				});
			},
			function setInitialGroupMembership(callback) {
				userGroup.getGroupsByName(Config.users.defaultGroups, function defaultGroups(err, groups) {
					if(err) {
						callback(err);
					} else {
						self.groups = groups;
						callback(null);
					}
				});
			},
			function setInitialSysOpGroupMembership(callback) {
				if(1 !== self.userId) {
					callback(null);
					return;
				}

				userGroup.getGroupsByName( [ 'sysops' ], function sysopGroups(err, groups) {
					if(err) {
						callback(err);
					} else {
						_.assign(self.groups, self.groups, groups);
						callback(null);
					}
				});
			},
			function saveAll(callback) {
				self.persist(false, function persisted(err) {
					callback(err);
				});
			}
		],
		function complete(err) {
			if(err) {
				var originalError = err;
				userDb.run('ROLLBACK;', function rollback(err) {
					assert(!err);
					cb(originalError);
				});
			} else {
				userDb.run('COMMIT;', function commited(err) {
					cb(err);
				});
			}
		}
	);
};

User.prototype.persist = function(useTransaction, cb) {
	assert(this.userId > 0);

	var self = this;

	async.series(
		[
			function beginTransaction(callback) {
				if(useTransaction) {
					userDb.run('BEGIN;', function transBegin(err) {
						callback(err);
					});
				} else {
					callback(null);
				}
			},
			function saveProps(callback) {
				self.persistProperties(function persisted(err) {
					callback(err);
				});
			},
			function saveGroups(callback) {
				userGroup.addUserToGroups(self.userId, self.groups, function groupsSaved(err) {
					callback(err);
				});
			}
		],
		function complete(err) {
			if(err) {
				if(useTransaction) {
					userDb.run('ROLLBACK;', function rollback(err) {
						cb(err);
					});
				} else {
					cb(err);
				}
			} else {
				if(useTransaction) {
					userDb.run('COMMIT;', function commited(err) {
						cb(err);
					});
				} else {
					cb(null);
				}
			}
		}
	);
};

User.prototype.persistProperties = function(cb) {
	assert(this.userId > 0);

	var self = this;

	var stmt = userDb.prepare(
		'REPLACE INTO user_property (user_id, prop_name, prop_value) ' + 
		'VALUES (?, ?, ?);');

	async.each(Object.keys(this.properties), function property(propName, callback) {
		stmt.run(self.userId, propName, self.properties[propName], function onRun(err) {
			callback(err);
		});
	}, function complete(err) {
		if(err) {
			cb(err);
		} else {
			stmt.finalize(function finalized() {
				cb(null);
			});
		}
	});
};

///////////////////////////////////////////////////////////////////////////////
//	Exported methods
///////////////////////////////////////////////////////////////////////////////
function getUserIdAndName(username, cb) {
	userDb.get(
		'SELECT id, user_name ' +
		'FROM user ' +
		'WHERE user_name LIKE ?;',
		[ username ],
		function onResults(err, row) {
			if(err) {
				cb(err);
			} else {
				if(row) {
					cb(null, row.id, row.user_name);
				} else {
					cb(new Error('No matching username'));
				}
			}
		}
	);
}

///////////////////////////////////////////////////////////////////////////////
//	Internal utility methods
///////////////////////////////////////////////////////////////////////////////
function generatePasswordDerivedKeyAndSalt(password, cb) {
	async.waterfall(
		[
			function getSalt(callback) {
				generatePasswordDerivedKeySalt(function onSalt(err, salt) {
					callback(err, salt);
				});
			},
			function getDk(salt, callback) {
				generatePasswordDerivedKey(password, salt, function onDk(err, dk) {
					callback(err, salt, dk);
				});
			}
		],
		function onComplete(err, salt, dk) {
			cb(err, { salt : salt, dk : dk });
		}
	);
}

function generatePasswordDerivedKeySalt(cb) {
	crypto.randomBytes(User.PBKDF2.saltLen, function onRandSalt(err, salt) {
		if(err) {
			cb(err);
		} else {
			cb(null, salt.toString('hex'));
		}
	});
}

function generatePasswordDerivedKey(password, salt, cb) {
	password = new Buffer(password).toString('hex');
	crypto.pbkdf2(password, salt, User.PBKDF2.iterations, User.PBKDF2.keyLen, function onDerivedKey(err, dk) {
		if(err) {
			cb(err);
		} else {
			cb(null, dk.toString('hex'));
		}
	});
}

function loadProperties(options, cb) {
	assert(options.userId);

	var sql =
		'SELECT prop_name, prop_value ' +
		'FROM user_property ' +
		'WHERE user_id = ?';

	if(options.names) {
		sql +=' AND prop_name IN("' + options.names.join('","') + '");';
	} else {
		sql += ';';
	}

	var properties = {};

	userDb.each(sql, [ options.userId ], function onRow(err, row) {
		if(err) {
			cb(err);
			return;
		} else {
			properties[row.prop_name] = row.prop_value;
		}
	}, function complete() {
		cb(null, properties);
	});
}
