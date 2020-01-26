/* jslint node: true */
'use strict';

var TextView		= require('./text_view.js').TextView;
var miscUtil		= require('./misc_util.js');
var strUtil			= require('./string_util.js');
var util			= require('util');
var assert			= require('assert');

exports.EditTextView	= EditTextView;

function EditTextView(client, options) {
	options.acceptsFocus 	= miscUtil.valueWithDefault(options.acceptsFocus, true);
	options.acceptsInput	= miscUtil.valueWithDefault(options.acceptsInput, true);
	options.inputType		= miscUtil.valueWithDefault(options.inputType, 'normal');

	TextView.call(this, client, options);

	assert(this.inputType in EditTextView.InputTypes);

	this.clientBackspace = function() {
		this.client.term.write(
			'\b' + this.getANSIColor(this.getColor()) + this.fillChar + '\b' + this.getANSIColor(this.getFocusColor()));
	};
}

util.inherits(EditTextView, TextView);

EditTextView.InputTypes = {
	normal			: 1,
	email			: 2,
	numeric			: 3,
	alpha			: 4,
	alphaNumeric	: 5,
	phone			: 6,
};
Object.freeze(EditTextView.InputTypes);

EditTextView.prototype.isKeyValidForInputType = function(key) {
	//	:TODO: add in the actual validations:
	switch(this.inputType) {
		case 'normal' 	: return true;
		case 'email'	: return true;	//	:TODO: validate based on char + position
		case 'numeric'	: return !isNaN(key);
	}

	return true;
};

EditTextView.prototype.onKeyPress = function(key, isSpecial) {	
	if(isSpecial) {
		return;
	}

	assert(1 === key.length);

	if(!this.isKeyValidForInputType(key)) {
		return;
	}

	//	:TODO: how to handle justify left/center?

	if(this.text.length < this.options.maxLength) {
		key = strUtil.stylizeString(key, this.textStyle);

		this.text += key;

		if(this.textMaskChar) {
			this.client.term.write(this.textMaskChar);
		} else {
			this.client.term.write(key);
		}
	}

	EditTextView.super_.prototype.onKeyPress.call(this, key, isSpecial);
};

EditTextView.prototype.onSpecialKeyPress = function(keyName) {
	//	:TODO: handle 'enter' & others for multiLine

	if(this.isSpecialKeyMapped('backspace', keyName)) {
		if(this.text.length > 0) {
			this.text = this.text.substr(0, this.text.length - 1);
			this.clientBackspace();
		}
	}

	EditTextView.super_.prototype.onSpecialKeyPress.call(this, keyName);
};