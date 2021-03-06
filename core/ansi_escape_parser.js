/* jslint node: true */
'use strict';

var miscUtil	= require('./misc_util.js');
var ansi		= require('./ansi_term.js');

var events		= require('events');
var util		= require('util');
var _			= require('lodash');

exports.ANSIEscapeParser		= ANSIEscapeParser;

var CR = 0x0d;
var LF = 0x0a;

//
//	Resources, Specs, etc.
//
//	* https://github.com/M-griffin/EtherTerm/blob/master/ansiParser.cpp

function ANSIEscapeParser(options) {
	var self = this;

	events.EventEmitter.call(this);

	this.column				= 1;
	this.row				= 1;
	this.scrollBack			= 0;
	this.graphicRendition	= {};

	this.parseState = {
		re	: /(?:\x1b\x5b)([\?=;0-9]*?)([ABCDHJKfhlmnpsu])/g,
	};

	options = miscUtil.valueWithDefault(options, {
		mciReplaceChar		: '',
		termHeight			: 25,
		termWidth			: 80,
	});

	this.mciReplaceChar		= miscUtil.valueWithDefault(options.mciReplaceChar, '');
	this.termHeight			= miscUtil.valueWithDefault(options.termHeight, 25);
	this.termWidth			= miscUtil.valueWithDefault(options.termWidth, 80);

	
	function getArgArray(array) {
		var i = array.length;
		while(i--) {
			array[i] = parseInt(array[i], 10);
		}
		return array;
	}

	self.moveCursor = function(cols, rows) {
		self.column	+= cols;
		self.row	+= rows;

		self.column	= Math.max(self.column, 1);
		self.column	= Math.min(self.column, self.termWidth);
		self.row	= Math.max(self.row, 1);		
		self.row	= Math.min(self.row, self.termHeight);

		self.emit('move cursor', self.column, self.row);
		self.rowUpdated();
	};

	self.saveCursorPosition = function() {
		self.savedPosition = {
			row		: self.row,
			column	: self.column
		};
	};

	self.restoreCursorPosition = function() {
		self.row	= self.savedPosition.row;
		self.column	= self.savedPosition.column;
		delete self.savedPosition;
		self.rowUpdated();
	};

	self.clearScreen = function() {
		//	:TODO: should be doing something with row/column?
		self.emit('clear screen');
	};

	self.rowUpdated = function() {
		self.emit('row update', self.row + self.scrollBack);
	};

	function literal(text) {
		var charCode;

		var len = text.length;
		for(var i = 0; i < len; i++) {
			charCode = text.charCodeAt(i) & 0xff;	//	ensure 8 bit
			switch(charCode) {
				case CR : 
					self.column = 1;
					break;

				case LF : 
					self.row++;
					self.rowUpdated();		
					break;

				default :
					//	wrap
					if(self.column === self.termWidth) {
						self.column = 1;
						self.row++;
						self.rowUpdated();
					} else {
						self.column++;
					}
					break;
			}

			if(self.row === 26) {	//	:TODO: should be termHeight + 1 ?
				self.scrollBack++;
				self.row--;
				self.rowUpdated();
			}
		}

		self.emit('chunk', text);
	}

	function getProcessedMCI(mci) {
		if(self.mciReplaceChar.length > 0) {
			return ansi.getSGRFromGraphicRendition(self.graphicRendition, true) + new Array(mci.length + 1).join(self.mciReplaceChar);
		} else {
			return mci;
		}
	}

	function parseMCI(buffer) {
		//	:TODO: move this to "constants" seciton @ top
		var mciRe = /\%([A-Z]{2})([0-9]{1,2})?(?:\(([0-9A-Za-z,]+)\))*/g;
		var pos = 0;
		var match;
		var mciCode;
		var args;
		var id;

		do {
			pos		= mciRe.lastIndex;
			match	= mciRe.exec(buffer);

			if(null !== match) {
				if(match.index > pos) {
					literal(buffer.slice(pos, match.index));
				}

				mciCode	= match[1];
				id		= match[2] || null;

				if(match[3]) {
					args = match[3].split(',');
				} else {
					args = [];
				}

				//	if MCI codes are changing, save off the current color
				var fullMciCode = mciCode + (id || '');
				if(self.lastMciCode !== fullMciCode) {

					self.lastMciCode = fullMciCode;

					self.graphicRenditionForErase = _.clone(self.graphicRendition, true);
				}

				
				self.emit('mci', { 
					mci		: mciCode, 
					id		: id ? parseInt(id, 10) : null,
					args	: args, 
					SGR		: ansi.getSGRFromGraphicRendition(self.graphicRendition, true)
					});

				if(self.mciReplaceChar.length > 0) {
					self.emit('chunk', ansi.getSGRFromGraphicRendition(self.graphicRenditionForErase));
					literal(new Array(match[0].length + 1).join(self.mciReplaceChar));
				} else {
					literal(match[0]);
				}

				//literal(getProcessedMCI(match[0]));

				//self.emit('chunk', getProcessedMCI(match[0]));
			}

		} while(0 !== mciRe.lastIndex);

		if(pos < buffer.length) {
			literal(buffer.slice(pos));
		}
	}

	self.reset = function(buffer) {
		self.parseState = {
			//	ignore anything past EOF marker, if any
			buffer	: buffer.split(String.fromCharCode(0x1a), 1)[0],
			re		: /(?:\x1b\x5b)([\?=;0-9]*?)([ABCDHJKfhlmnpsu])/g,
			stop	: false,
		};
	};

	self.stop = function()  {
		self.parseState.stop = true;
	};

	self.parse = function() {
		//	:TODO: ensure this conforms to ANSI-BBS / CTerm / bansi.txt for movement/etc.
		var pos;
		var match;
		var opCode;
		var args;
		var re		= self.parseState.re;
		var buffer	= self.parseState.buffer;

		self.parseState.stop = false;

		do {
			if(self.parseState.stop) {
				return;
			}

			pos		= re.lastIndex;
			match	= re.exec(buffer);

			if(null !== match) {
				if(match.index > pos) {
					parseMCI(buffer.slice(pos, match.index));
				}

				opCode	= match[2];
				args	= getArgArray(match[1].split(';'));

				escape(opCode, args);

				self.emit('chunk', match[0]);
			}
		} while(0 !== re.lastIndex);

		if(pos < buffer.length) {
			parseMCI(buffer.slice(pos));
		}

		self.emit('complete');
	};

/*
	self.parse = function(buffer, savedRe) {
		//	:TODO: ensure this conforms to ANSI-BBS / CTerm / bansi.txt for movement/etc.
		//	:TODO: move this to "constants" section @ top
		var re	= /(?:\x1b\x5b)([\?=;0-9]*?)([ABCDHJKfhlmnpsu])/g;
		var pos = 0;
		var match;
		var opCode;
		var args;

		//	ignore anything past EOF marker, if any
		buffer = buffer.split(String.fromCharCode(0x1a), 1)[0];

		do {
			pos		= re.lastIndex;
			match	= re.exec(buffer);

			if(null !== match) {
				if(match.index > pos) {
					parseMCI(buffer.slice(pos, match.index));
				}

				opCode	= match[2];
				args	= getArgArray(match[1].split(';'));

				escape(opCode, args);

				self.emit('chunk', match[0]);
			}



		} while(0 !== re.lastIndex);

		if(pos < buffer.length) {
			parseMCI(buffer.slice(pos));
		}

		self.emit('complete');
	};
	*/

	function escape(opCode, args) {
		var arg;
		var i;
		var len;

		switch(opCode) {
			//	cursor up
			case 'A' :
				arg = args[0] || 1;
				self.moveCursor(0, -arg);
				break;

			//	cursor down
			case 'B' :
				arg = args[0] || 1;
				self.moveCursor(0, arg);
				break;

			//	cursor forward/right
			case 'C' :
				arg = args[0] || 1;
				self.moveCursor(arg, 0);
				break;

			//	cursor back/left
			case 'D' :
				arg = args[0] || 1;
				self.moveCursor(-arg, 0);
				break;

			case 'f' :	//	horiz & vertical
			case 'H' :	//	cursor position
				self.row	= args[0] || 1;
				self.column	= args[1] || 1;
				self.rowUpdated();
				break;

			//	save position
			case 's' : 
				self.saveCursorPosition();
				break;

			//	restore position
			case 'u' : 
				self.restoreCursorPosition();
				break;

			//	set graphic rendition
			case 'm' :
				for(i = 0, len = args.length; i < len; ++i) {
					arg = args[i];

					if(ANSIEscapeParser.foregroundColors[arg]) {
						self.graphicRendition.fg = arg;
					} else if(ANSIEscapeParser.backgroundColors[arg]) {
						self.graphicRendition.bg = arg;
					} else if(ANSIEscapeParser.styles[arg]) {
						switch(arg) {
							case 0 :
								//	clear out everything
								delete self.graphicRendition.intensity;
								delete self.graphicRendition.underline;
								delete self.graphicRendition.blink;
								delete self.graphicRendition.negative;
								delete self.graphicRendition.invisible;

								self.graphicRendition.fg = 39;
								self.graphicRendition.bg = 49;
								break;

							case 1 :
							case 2 :
							case 22 : 
								self.graphicRendition.intensity = arg;
								break;

							case 4 :
							case 24 :
								self.graphicRendition.underline = arg;
								break;

							case 5 :
							case 6 :
							case 25 :
								self.graphicRendition.blink = arg;
								break;

							case 7 :
							case 27 :
								self.graphicRendition.negative = arg;
								break;

							case 8 :
							case 28 :
								self.graphicRendition.invisible = arg;
								break;

							default :
								console.log('Unknown attribute: ' + arg);	//	:TODO: Log properly
								break;
						}
					}
				}

				break;

			//	erase display/screen
			case 'J' :
				//	:TODO: Handle others
				if(2 === args[0]) {
					self.clearScreen();
				}
				break;
		}
	}
}

util.inherits(ANSIEscapeParser, events.EventEmitter);

ANSIEscapeParser.foregroundColors = {
	30	: 'black',
	31	: 'red',
	32	: 'green',
	33	: 'yellow',
	34	: 'blue',
	35	: 'magenta',
	36	: 'cyan',
	37	: 'white',
	39	: 'default',	//	same as white for most implementations

	90	: 'grey'
};
Object.freeze(ANSIEscapeParser.foregroundColors);

ANSIEscapeParser.backgroundColors = {
	40	: 'black',
	41	: 'red',
	42	: 'green',
	43	: 'yellow',
	44	: 'blue',
	45	: 'magenta',
	46	: 'cyan',
	47	: 'white',
	49	: 'default',	//	same as black for most implementations
};
Object.freeze(ANSIEscapeParser.backgroundColors);

//	:TODO: ensure these names all align with that of ansi_term.js
//
//	See the following specs:
//	* http://www.ansi-bbs.org/ansi-bbs-core-server.html
//	* http://www.vt100.net/docs/vt510-rm/SGR
//	* https://github.com/protomouse/synchronet/blob/master/src/conio/cterm.txt
//
//	Note that these are intentionally not in order such that they
//	can be grouped by concept here in code.
//
ANSIEscapeParser.styles = {
	0		: 'default',			//	Everything disabled

	1		: 'intensityBright',	//	aka bold
	2		: 'intensityDim',
	22		: 'intensityNormal',

	4		: 'underlineOn',		//	Not supported by most BBS-like terminals
	24		: 'underlineOff',		//	Not supported by most BBS-like terminals

	5		: 'blinkSlow',			//	blinkSlow & blinkFast are generally treated the same
	6		: 'blinkFast',			//	blinkSlow & blinkFast are generally treated the same
	25		: 'blinkOff',

	7		: 'negativeImageOn',	//	Generally not supported or treated as "reverse FG & BG"
	27		: 'negativeImageOff',	//	Generally not supported or treated as "reverse FG & BG"

	8		: 'invisibleOn',		//	FG set to BG
	28		: 'invisibleOff',		//	Not supported by most BBS-like terminals
};
Object.freeze(ANSIEscapeParser.styles);