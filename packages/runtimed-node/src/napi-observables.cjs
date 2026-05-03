"use strict";

function parseJsonEvent(json) {
  return typeof json === "string" ? JSON.parse(json) : json;
}

module.exports = {
  parseJsonEvent,
};
