"use strict";

const { Subject } = require("rxjs");

function parseJsonEvent(json) {
  return typeof json === "string" ? JSON.parse(json) : json;
}

function callbackObservable(register) {
  const subject = new Subject();
  const subscription = register((json) => {
    try {
      subject.next(parseJsonEvent(json));
    } catch (error) {
      subject.error(error);
    }
  });
  const observable = subject.asObservable();
  observable.dispose = () => {
    subscription?.dispose?.();
    subject.complete();
  };
  return observable;
}

module.exports = {
  callbackObservable,
  parseJsonEvent,
};
