/**
 * @runtimed/node — thin JS wrapper over the N-API binding.
 *
 * The native binding lives in `binding.cjs` + `runtimed-node.<triple>.node`.
 * This file exists so consumers can `require('@runtimed/node')`
 * without thinking about platform suffixes.
 */
"use strict";

const binding = require("./binding.cjs");
const { Session } = require("./session.cjs");

async function createNotebook(options) {
  return new Session(await binding.createNotebook(options));
}

async function openNotebook(notebookId, options) {
  return new Session(await binding.openNotebook(notebookId, options));
}

module.exports = {
  ...binding,
  createNotebook,
  openNotebook,
  NativeSession: binding.Session,
  Session,
};
