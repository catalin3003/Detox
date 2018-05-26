const _ = require('lodash');
const fs = require('fs-extra');
const path = require('path');
const log = require('npmlog');
const argparse = require('../utils/argparse');
const logError = require('../utils/logError');
const DetoxRuntimeError = require('../errors/DetoxRuntimeError');
const ArtifactPathBuilder = require('./utils/ArtifactPathBuilder');

class ArtifactsManager {
  constructor() {
    this.onTerminate = _.once(this.onTerminate.bind(this));

    this._idlePromise = Promise.resolve();
    this._onIdleCallbacks = [];
    this._activeArtifacts = [];
    this._artifactPlugins = [];

    this._deviceId = '';
    this._bundleId = '';
    this._pid = NaN;

    const pathBuilder = new ArtifactPathBuilder({
      artifactsRootDir: argparse.getArgValue('artifacts-location') || 'artifacts',
    });

    this.artifactsApi = {
      getDeviceId: () => {
        if (!this._deviceId) {
          throw new DetoxRuntimeError({
            message: 'Detox Artifacts API had no deviceId at the time of calling',
          });
        }

        return this._deviceId;
      },

      getBundleId: () => {
        if (!this._bundleId) {
          throw new DetoxRuntimeError({
            message: 'Detox Artifacts API had no bundleId at the time of calling',
          });
        }

        return this._bundleId;
      },

      getPid: () => {
        if (!this._pid) {
          throw new DetoxRuntimeError({
            message: 'Detox Artifacts API had no app pid at the time of calling',
          });
        }

        return this._pid;
      },

      preparePathForArtifact: async (artifactName, testSummary) => {
        const artifactPath = pathBuilder.buildPathForTestArtifact(artifactName, testSummary);
        const artifactDir = path.dirname(artifactPath);
        await fs.ensureDir(artifactDir);

        return artifactPath;
      },

      trackArtifact: (artifact) => {
        this._activeArtifacts.push(artifact);
      },

      untrackArtifact(artifact) {
        _.pull(this._activeArtifacts, artifact);
      },

      requestIdleCallback: (callback, caller) => {
        callback._from = caller.name;
        this._onIdleCallbacks.push(callback);

        this._idlePromise = this._idlePromise
          .then(() => this._terminated
            ? this._runAllIdleTasks()
            : this._runNextIdleTask());
      },
    };
  }

  async _runNextIdleTask() {
    const onIdleCallback = this._onIdleCallbacks.shift();

    if (onIdleCallback) {
      return Promise.resolve().then(onIdleCallback).catch(e => {
        this._idleCallbackErrorHandle(e, onIdleCallback);
      });
    }
  }

  async _runAllIdleTasks() {
    const onIdleCallbacks = this._onIdleCallbacks.splice(0);

    return Promise.all(onIdleCallbacks.map((onIdleCallback) => {
      return Promise.resolve().then(onIdleCallback).catch(e => {
        return this._idleCallbackErrorHandle(e, onIdleCallback);
      });
    }));
  }

  registerArtifactPlugins(artifactPluginFactoriesMap = {}) {
    const artifactPluginFactories = Object.values(artifactPluginFactoriesMap);
    this._artifactPlugins = artifactPluginFactories.map(factory => factory(this.artifactsApi));
  }

  subscribeToDeviceEvents(device) {
    device.on('beforeResetDevice', async (e) => this.onBeforeResetDevice(e));
    device.on('resetDevice', async (e) => this.onResetDevice(e));
    device.on('launchApp', async (e) => this.onLaunchApp(e));
  }

  async onLaunchApp({ deviceId, bundleId, pid }) {
    const isFirstTime = !this._deviceId;

    this._deviceId = deviceId;
    this._bundleId = bundleId;
    this._pid = pid;

    if (!isFirstTime) {
      await this._emit('onRelaunchApp', [{ deviceId, bundleId, pid}]);
    }
  }

  async onBeforeAll() {
    await this._emit('onBeforeAll', []);
  }

  async onBeforeTest(testSummary) {
    await this._emit('onBeforeTest', [testSummary]);
  }

  async onBeforeResetDevice({ deviceId }) {
    await this._emit('onBeforeResetDevice', [{ deviceId }]);
  }

  async onResetDevice({ deviceId }) {
    await this._emit('onResetDevice', [{ deviceId }]);
  }

  async onAfterTest(testSummary) {
    await this._emit('onAfterTest', [testSummary]);
  }

  async onAfterAll() {
    await this._emit('onAfterAll', []);
    await this._idlePromise;
    log.verbose('ArtifactsManager', 'finalized artifacts successfully');
  }

  async onTerminate() {
    await Promise.all(this._artifactPlugins.map(plugin => plugin.onTerminate()));
    await Promise.all(this._activeArtifacts.map(artifact => artifact.discard()));
    log.info('ArtifactsManager', 'terminated all artifacts');
  }

  async _emit(methodName, args) {
    await Promise.all(this._artifactPlugins.map(async (plugin) => {
      try {
        await plugin[methodName](...args);
      } catch (e) {
        this._errorHandler(e, { plugin, methodName, args });
      }
    }));
  }

  _errorHandler(e, { plugin, methodName }) {
    log.error('ArtifactsManager', 'Caught exception inside plugin (%s) at phase %s', plugin.name || 'unknown', methodName);
    logError(e, 'ArtifactsManager');
  }

  _idleCallbackErrorHandle(e, callback) {
    this._errorHandler(e, {
      plugin: { name: callback._from },
      methodName: 'onIdleCallback',
      args: []
    })
  }
}


module.exports = ArtifactsManager;