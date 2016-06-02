'use strict';

const assert = require('assert');
const electronVersion = require('electron-prebuilt/package.json').version;
const mock = require('mock-require');
const debug = require('debug')('hadron-auto-update-manager:test');
let AutoUpdateManager = require('../');



describe('hadron-auto-update-manager', () => {
  it('should have an export', () => {
    assert(AutoUpdateManager);
  });
  it('should require an arg to the constructor', () => {
    assert.throws( () => new AutoUpdateManager());
  });
  it('should setup', () => {
    const endpoint = 'https://hadron-endpoint.herokuapp.com';
    const autoUpdateManager = new AutoUpdateManager(endpoint);
    assert.equal(autoUpdateManager.version, electronVersion);
    assert.equal(autoUpdateManager.feedURL,
      `https://hadron-endpoint.herokuapp.com/update?version=${electronVersion}&platform=${process.platform}&arch=${process.arch}`);
  });

  describe('checkForUpdates', function() {
    context('with mocked https module', function() {

      context('does not have new update', function() {
        before(function() {
          mock('https', {
            get: function(options, callback) {
              setTimeout(callback.bind(null, {statusCode: 204}), 100);
              return {
                on: function() {}
              };
            }
          });
          AutoUpdateManager = mock.reRequire('../');
        });

        after(function() {
          mock.stop('https');
          AutoUpdateManager = mock.reRequire('../');
        });

        it('should eventually go into `update-not-available` state', function(done) {
          const endpoint = 'https://hadron-endpoint.herokuapp.com';
          const autoUpdateManager = new AutoUpdateManager(endpoint);
          autoUpdateManager.on('state-changed', function(state) {
            if (state === 'update-not-available') {
              done();
            }
          });
          autoUpdateManager.checkForUpdates();
        });
      });

      context('has new update', function() {
        before(function() {
          mock('https', {
            get: function(options, callback) {
              setTimeout(callback.bind(null, {statusCode: 200}), 100);
              return {
                on: function() {}
              };
            }
          });
          AutoUpdateManager = mock.reRequire('../');
        });

        after(function() {
          mock.stop('https');
          AutoUpdateManager = mock.reRequire('../');
        });

        it('should eventually go into `update-available` state', function(done) {
          const endpoint = 'https://hadron-endpoint.herokuapp.com';
          const autoUpdateManager = new AutoUpdateManager(endpoint);
          autoUpdateManager.on('state-changed', function(state) {
            if (state === 'update-available') {
              done();
            }
          });
          autoUpdateManager.checkForUpdates();
        });
      });
    });
  });
});
