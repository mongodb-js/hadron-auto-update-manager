# hadron-auto-update-manager [![travis][travis_img]][travis_url] [![npm][npm_img]][npm_url]

> Atom's [`AutoUpdateManager`](https://github.com/atom/atom/blob/master/src/browser/auto-update-manager.coffee) class as a standalone module.

This module is a wrapper around Electron's auto-updater that adds additional
features like "check before you download" and some convenience methods.

The main issue with Electron's auto-updater is that once you run `.checkForUpdates()`,
there is no going back. If a newer version is available, it will go fetch the
binary, download and install it. We don't want this behavior, instead we'd
like to get user confirmation first before we download, and again before we
restart the application.

Therefore this module checks for a newer version first (with a `https.get()`
request) and re-wires some of the existing events.

Also read this [blog post][updater-blog] for more information on auto-updates
for Electron apps.

## Example

```javascript
const path = require('path');
const AutoUpdateManager = require('hadron-auto-update-manager');

const autoUpdater = new AutoUpdateManager({
    endpoint: 'https://compass-mongodb-com.herokuapp.com',
    icon_path: path.join(__dirname, '..', 'resources', 'mongodb-compass.png')
  })
  .on('update-available', () => {
    autoUpdater.download();
  })
  .on('update-downloaded', () => {
    autoUpdater.install();
  })
  .check();

```
## License

Apache 2.0

[electron-auto-updater]: https://github.com/electron/electron/blob/master/docs/api/auto-updater.md
[updater-blog]: https://medium.com/@svilen/auto-updating-apps-for-windows-and-osx-using-electron-the-complete-guide-4aa7a50b904c#.q793uggoq
[travis_img]: https://img.shields.io/travis/mongodb-js/hadron-auto-update-manager.svg
[travis_url]: https://travis-ci.org/mongodb-js/hadron-auto-update-manager
[npm_img]: https://img.shields.io/npm/v/hadron-auto-update-manager.svg
[npm_url]: https://npmjs.org/package/hadron-auto-update-manager
