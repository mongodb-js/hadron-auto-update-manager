'use strict';

/**
 * This module is a wrapper around Electron's auto-updater that adds additional
 * features like "check before you download" and some convenience methods.
 *
 * @see https://github.com/electron/electron/blob/master/docs/api/auto-updater.md
 * @see https://medium.com/@svilen/auto-updating-apps-for-windows-and-osx-using-electron-the-complete-guide-4aa7a50b904c#.q793uggoq
 *
 * The main issue with Electron's auto-updater is that once you run `.checkForUpdates()`,
 * there is no going back. If a newer version is available, it will go fetch the
 * binary, download and install it. We don't want this behavior, instead we'd
 * like to get user confirmation first before we download, and again before we
 * restart the application.
 *
 * Therefore this module checks for a newer version first (with a https.get()
 * request) and re-wires some of the existing events.
 */

/* eslint eqeqeq: 1,
   no-console:0,
   no-else-return: 1,
   no-cond-assign: 1,
   consistent-return: 1 */

const path = require('path');
const fs = require('fs');
const _ = require('lodash');
const EventEmitter = require('events').EventEmitter;
const https = require('https');

const electron = require('electron');
const BrowserWindow = electron.BrowserWindow;
const dialog = electron.dialog;
const app = electron.app;
const autoUpdater = require('./auto-updater');

const debug = require('debug')('hadron-auto-update-manager');

/*
 * States of the auto updater state machine
 */
const IdleState = 'idle';
const CheckingState = 'checking';
const UpdateAvailableState = 'update-available';
const DownloadingState = 'downloading';
const UpdateDownloadedState = 'update-downloaded';
const NoUpdateAvailableState = 'update-not-available';
const UnsupportedState = 'unsupported';
const ErrorState = 'error';

const ENOSIGNATURE = 'Could not get code signature for running application';
const HTTP_NO_CONTENT = 204;

/**
 * Constructor
 *
 * @param {String} endpointURL    URL to update server
 * @param {String} iconURL        URL to icons
 */
function AutoUpdateManager(endpointURL, iconURL) {
  if (!endpointURL) {
    throw new TypeError('endpointURL is required!');
  }
  this.endpointURL = endpointURL;
  this.iconURL = iconURL;
  this.version = app.getVersion();
  this.onUpdateError = _.bind(this.onUpdateError, this);
  this.onUpdateNotAvailable = _.bind(this.onUpdateNotAvailable, this);
  this.state = IdleState;
  // TODO hack to get to the RELEASES file for windows updates
  if (process.platform === 'win32') {
    this.feedURL = `${endpointURL}/update/${process.platform}/${this.version}/RELEASES`;
  } else {
    this.feedURL = `${endpointURL}/update?version=${this.version}&platform=${process.platform}&arch=${process.arch}`;    
  }

  process.nextTick(() => {
    this.setupAutoUpdater();
  });
}
_.extend(AutoUpdateManager.prototype, EventEmitter.prototype);

/**
 * Enable auto updates with interval checks (every 4 hours) for new updates.
 *
 * @api public
 * @return {Boolean}   returns true if auto updates were enabled, false if
 *                     there was a problem or if they had been enabled already.
 */
AutoUpdateManager.prototype.enable = function() {
  if (this.state === 'unsupported') {
    debug('Not scheduling because updates are not supported.');
    return false;
  }
  return this.scheduleUpdateCheck();
};

/**
 * Disable auto updates (no more interval checks for new updates).
 *
 * @api public
 * @return {Boolean}  returns true if updates were disabled, false if they
 *                    already had been disabled previously.
 */
AutoUpdateManager.prototype.disable = function() {
  return this.cancelScheduledUpdateCheck();
};

/**
 * checks for updates now (but don't download), bypassing scheduled check.
 * The state will transition into `checking` during the check, and then
 * either `update-available` or `update-not-available`.
 *
 * @api public
 * @return {Boolean}  returns false if there was a problem, true if check
 *                    for updates happened.
 */
AutoUpdateManager.prototype.check = function() {
  if (this.state === 'unsupported') {
    debug('Updates are not supported.');
    return false;
  }
  return this.checkForUpdates();
};


/**
 * downloads the available update. Should only be called if in
 * `update-available` state. Changes into state `downloading` during the
 * download and into `download-available` after completion.
 *
 * @api public
 * @return {Boolean}  returns false if there was a problem, true if check
 *                    for updates happened.
 */
AutoUpdateManager.prototype.download = function() {
  if (this.state === 'unsupported') {
    debug('Updates are not supported.');
    return false;
  }
  if (this.state !== UpdateAvailableState) {
    debug('No update available.');
    return false;
  }
  return this.checkAndDownload();
};

/**
 * Install new update if it is available. Can only be executed if state is
 * `update-downloaded`. Will quit and restart the application.
 *
 * @api public
 * @return {Boolean}   returns false if no update is abvailable, true if
 *                     update is available and about to be installed.
 */
AutoUpdateManager.prototype.install = function() {
  if (this.state !== UpdateDownloadedState) {
    debug('No update to install.');
    return false;
  }

  debug('removing all event listeners for app#all-windows-closed');
  app.removeAllListeners('all-windows-closed');

  debug('installing via autoUpdater.quitAndInstall()');
  autoUpdater.quitAndInstall();
  return true;
};

/**
 * Private APIs below.
 */

/**
 * Sets up event handlers for auto updates.
 * @api private
 */
AutoUpdateManager.prototype.setupAutoUpdater = function() {
  // Need to set error event handler before setting feedURL.
  // Else we get the default node.js error event handling:
  // die hard if errors are unhandled.
  autoUpdater.on('error', (event, message) => {
    if (message === ENOSIGNATURE) {
      debug('no auto updater for unsigned builds');
      return this.setState(UnsupportedState);
    }
    debug('Error Downloading Update: ' + message);
    return this.setState(ErrorState, message);
  });

  autoUpdater.setFeedURL(this.feedURL);

  autoUpdater.on('update-not-available', () => {
    this.setState(NoUpdateAvailableState);
  });
  autoUpdater.on('update-available', () => {
    this.setState(DownloadingState);
  });
  autoUpdater.on('update-downloaded', (event, releaseNotes, releaseVersion) => {
    this.releaseNotes = releaseNotes;
    this.releaseVersion = releaseVersion;
    this.setState(UpdateDownloadedState);
  });
};

/**
 * Sets interval timer to check for updates every 4 hours.
 *
 * @api private
 * @return {Boolean}  returns true if the check has been scheduled, false if it
 *                    was already scheduled previously.
 */
AutoUpdateManager.prototype.scheduleUpdateCheck = function() {
  if (this.checkForUpdatesIntervalID) {
    debug('Update check already scheduled');
    return false;
  }
  var fourHours = 1000 * 60 * 60 * 4;
  var checkForUpdates = this.checkForUpdates.bind(this, {
    hidePopups: true
  });
  this.checkForUpdatesIntervalID = setInterval(checkForUpdates, fourHours);
  this.checkForUpdates();
  return true;
};

/**
 * Cancels interval timer for update checks.
 *
 * @api private
 * @return {Boolean}  returns true if the check was cancelled, false if it
 *                    was not previously scheduled.
 */
AutoUpdateManager.prototype.cancelScheduledUpdateCheck = function() {
  if (this.checkForUpdatesIntervalID) {
    clearInterval(this.checkForUpdatesIntervalID);
    this.checkForUpdatesIntervalID = null;
    debug('cancelled scheduled update check');
    return true;
  }
  return false;
};

/**
 * check manually via https.get() if an update is available now, but
 * don't download it yet.
 *
 * @api private
 * @param  {Object} opts   options object, can have `hidePopups` boolean field
 *                         to indicate whether a popup should be shown to give
 *                         user feedback.
 * @return {Boolean}       returns true
 */
AutoUpdateManager.prototype.checkForUpdates = function(opts) {
  var autoUpdateMgr = this;
  autoUpdateMgr.setState(CheckingState);

  opts = opts || {};
  if (!opts.hidePopups) {
    autoUpdateMgr.once('update-not-available', this.onUpdateNotAvailable);
    autoUpdateMgr.once('error', this.onUpdateError);
  }

  // send request to server
  https.get(this.feedURL + '&download=false', function(res) {
    if (res.statusCode === HTTP_NO_CONTENT) {
      // no updates available
      return autoUpdateMgr.setState(NoUpdateAvailableState);
    }
    autoUpdateMgr.setState(UpdateAvailableState);
  }).on('error', function(e) {
    debug('error while checking for update', e);
    autoUpdateMgr.setState(ErrorState, e);
  });
};

/**
 * check if update available and automatically download it.
 *
 * @api private
 * @param  {Object} opts   options object, can have `hidePopups` boolean field
 *                         to indicate whether a popup should be shown to give
 *                         user feedback.
 * @return {Boolean}       returns true
 */
AutoUpdateManager.prototype.checkAndDownload = function(opts) {
  opts = opts || {};
  if (!opts.hidePopups) {
    autoUpdater.once('error', this.onUpdateError);
  }
  autoUpdater.checkForUpdates();
  return true;
};

/**
 * Sets the current state of the auto updater state machine and emits
 * a `state-changed` event. No-op if the state remains the same.
 *
 * @api private
 * @param  {String} state   new state
 * @return {[type]}         returns true if the event had listeners, false
 *                          otherwise.
 */
AutoUpdateManager.prototype.setState = function(state) {
  if (this.state === state) {
    return;
  }
  this.state = state;
  this.emit('state-changed', state);
  this.emit(state);
};

/**
 * get current state of the auto updater state machine.
 *
 * @api private
 * @return {String}  current state.
 */
AutoUpdateManager.prototype.getState = function() {
  return this.state;
};

/**
 * if opts.hidePopups was not set for `checkForUpdates`, this method
 * will inform the user with a popup dialog that there was no update available.
 *
 * @api private
 * @return {Number}   returns the index of the clicked button, see
 * https://github.com/electron/electron/blob/master/docs/api/dialog.md
 */
AutoUpdateManager.prototype.onUpdateNotAvailable = function() {
  debug('update not available', arguments);
  this.removeListener('error', this.onUpdateError);
  autoUpdater.removeListener('error', this.onUpdateError);
  return dialog.showMessageBox({
    type: 'info',
    buttons: ['OK'],
    icon: this.iconURL,
    message: 'No update available.',
    title: 'No Update Available',
    detail: 'You\'re running the latest version (' + this.version + ').'
  });
};

/**
 * if opts.hidePopups was not set for `checkForUpdates`, this method
 * will inform the user with a popup dialog that there was an error checking
 * for updates.
 *
 * @api private
 * @return {Number}   returns the index of the clicked button, see
 * https://github.com/electron/electron/blob/master/docs/api/dialog.md
 */
AutoUpdateManager.prototype.onUpdateError = function(event, message) {
  debug('update error', arguments);
  this.removeListener('update-not-available', this.onUpdateNotAvailable);
  return dialog.showMessageBox({
    type: 'warning',
    buttons: ['OK'],
    icon: this.iconURL,
    message: 'There was an error checking for updates.',
    title: 'Update Error',
    detail: message
  });
};

module.exports = AutoUpdateManager;
