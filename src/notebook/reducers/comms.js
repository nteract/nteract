import { handleActions } from 'redux-actions';
import Immutable from 'immutable';

import * as constants from '../constants';

import {
  targetModules,
  targetModulesInit,
} from '../comm-targets/pure-model';

export default handleActions({
  // No one is using this --> we merely need a consistent structure
  [constants.REGISTER_COMM_TARGET]: function registerCommTarget(state, action) {
    return state.setIn(['targets', action.name], action.handler);
  },
  [constants.COMM_OPEN]: function openComm(state, action) {
    const {
      comm_id,
      target_name,
      target_module,
      metadata,
      buffers,
      data,
    } = action;

    const model = target_module in targetModulesInit ? targetModulesInit(data) : data;

    // Using a top-level Map here, not fromJS, since we don't
    // know if the underlying target/handler is using Immutable
    const comm = new Immutable.Map({
      target_name,
      target_module,
      metadata,
      data: model,
      buffers,
    });

    // TODO: Any initialization of the comm using the target
    return state.setIn(['comms', comm_id], comm);
  },
  // HACK: Only coding for pure-model for now
  [constants.COMM_MESSAGE]: function commMessage(state, action) {
    const {
      comm_id,
      data,
      buffers,
    } = action;

    const target_name = state.getIn(['comms', comm_id, 'target_name']);
    const target_module = state.getIn(['comms', comm_id, 'target_module']);

    // Reduce the model state
    if (target_name === 'pure-model') {
      const reducer = targetModules[target_module];
      return state.updateIn(['comms', comm_id, 'data'], (model) =>
        reducer(model, data)
      );
    }

    // TODO: Handle errors, wrap with try catch or find a way to handle in Redux

    return state;
  },
}, {});
