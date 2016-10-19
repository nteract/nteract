import { ajax } from 'rxjs/observable/dom/ajax';

/**
 * Creates the AJAX settings for a call to the sessions API.
 *
 * @param {Object} serverConfig - The server configuration
 *
 * @return {Object} settings - The settings to be passed to the AJAX request
 */
export function createSettingsForList(serverConfig) {
  const url = `${serverConfig.endpoint}/api/sessions`;
  return {
    url,
    crossDomain: serverConfig.crossDomain,
    responseType: 'json',
  };
}

/**
 * Creates the AJAX settings for a call to the sessions API.
 *
 * @param {Object} serverConfig - The server configuration
 *
 * @param {String} sessionID - Universally unique identifier for session to be requested.
 *
 * @return {Object} - The settings to be passed to the AJAX request
 */
export function createSettingsForGet(serverConfig, sessionID) {
  const url = `${serverConfig.endpoint}/api/sessions/${sessionID}`;
  return {
    url,
    crossDomain: serverConfig.crossDomain,
    responseType: 'json',
    headers: {
      'Content-Type': 'application/json',
    },
  };
}

/**
 * Creates the AJAX settings for a call to the sessions API.
 *
 * @param {Object} serverConfig  - The server configuration
 *
 * @param {String} sessionID - Universally unique identifier for session to be requested.
 *
 * @return {Object} - The settings to be passed to the AJAX request
 */
export function createSettingsForDestroy(serverConfig, sessionID) {
  const url = `${serverConfig.endpoint}/api/sessions/${sessionID}`;
  return {
    url,
    crossDomain: serverConfig.crossDomain,
    responseType: 'json',
    method: 'DELETE',
  };
}

/**
 * Creates the AJAX settings for a call to the sessions API.
 *
 * @param {Object} serverConfig  - The server configuration
 *
 * @param {String} sessionID - Universally unique identifier for session to be requested.
 *
 * @param {String} newSessionName - New name for session with param sessionID.
 *
 * @return  {Object} - The settings to be passed to the AJAX request
 */
export function createSettingsForRename(serverConfig, sessionID, newSessionName) {
  const url = `${serverConfig.endpoint}/api/sessions/${sessionID}`;
  return {
    url,
    crossDomain: serverConfig.crossDomain,
    responseType: 'json',
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'PATCH',
    body: {
      path: '~',
      session_name: newSessionName,
    },
  };
}

/**
 * Creates the AJAX settings for a call to the sessions API.
 *
 * @param {Object} serverConfig  - The server configuration
 *
 * @param {Object} payload - Object containing notebook_name, path, and kernel_name for request
 *
 * @return {Object} - The settings to be passed to the AJAX request
 */
export function createSettingsForCreate(serverConfig, { notebook_name, path, kernel_name }) {
  const url = `${serverConfig.endpoint}/api/sessions`;
  return {
    url,
    crossDomain: serverConfig.crossDomain,
    responseType: 'json',
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
    body: {
      session_name: '',
      notebook_name,
      path,
      kernel_name,
    },
  };
}

/**
 * Creates an AjaxObservable for listing available sessions.
 *
 * @param {Object} serverConfig  - The server configuration
 *
 * @param {String} sessionID - Universally unique identifier for session to be requested.
 *
 * @return  {Object}  An Observable with the request response
 */
export function list(serverConfig, sessionID) {
  return ajax(createSettingsForList(serverConfig, sessionID));
}

/**
 * Creates an AjaxObservable for getting a particular session's information.
 *
 * @param {Object} serverConfig  - The server configuration
 *
 * @param {String} sessionID - Universally unique identifier for session to be requested.
 *
 * @return  {Object}  An Observable with the request/response
 */
export function get(serverConfig, sessionID) {
  return ajax(createSettingsForGet(serverConfig, sessionID));
}

/**
 * Creates an AjaxObservable for destroying a particular session.
 *
 * @param {Object} serverConfig - The server configuration
 *
 * @param {String} sessionID - Universally unique identifier for session to be requested.
 *
 * @return {Object} - An Observable with the request/response
 */
export function destroy(serverConfig, sessionID) {
  return ajax(createSettingsForDestroy(serverConfig, sessionID));
}

/**
 * Creates an AjaxObservable for renaming a session given its sessionID.
 *
 * @param {Object} serverConfig - The server configuration
 *
 * @param {String} sessionID - Universally unique identifier for session to be requested.
 *
 * @param {String} sessionName - New name for session with param sessionID.
 *
 * @return  {Object}  An Observable with the request/response
 */
export function rename(serverConfig, sessionID, newSessionName) {
  return ajax(createSettingsForRename(serverConfig, sessionID, newSessionName));
}

/**
 * Creates an AjaxObservable for getting a particular session's information.
 *
 * @param {Object} serverConfig  - The server configuration
 *
 * @param {Object} payload - Object containing notebook_name, path, and kernel_name for request
 *
 * @return {Object} - An Observable with the request/response
 */
export function create(serverConfig, { notebook_name, path, kernel_name }) {
  return ajax(createSettingsForCreate(serverConfig, { notebook_name, path, kernel_name }));
}
