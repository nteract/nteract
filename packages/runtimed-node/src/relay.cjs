"use strict";

const binding = require("./binding.cjs");
const { RelaySession } = require("./relay-session.cjs");

async function createRelay(options) {
  return new RelaySession(await binding.createRelay(options));
}

async function openRelayPath(path, options) {
  return new RelaySession(await binding.openRelayPath(path, options));
}

async function connectRelay(notebookId, options) {
  return new RelaySession(await binding.connectRelay(notebookId, options));
}

async function queryDaemonInfo(options) {
  return binding.queryDaemonInfo(options);
}

module.exports = {
  RelaySession,
  createRelay,
  openRelayPath,
  connectRelay,
  queryDaemonInfo,
  bindingSourceRevision: binding.bindingSourceRevision,
  defaultSocketPath: binding.defaultSocketPath,
  socketPathForChannel: binding.socketPathForChannel,
};
