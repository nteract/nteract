# @nteract/mythic-rtc

This package implements a real-time collaboration experience for applications built with nteract.

## Installation

```
$ yarn add @nteract/mythic-rtc
```

```
$ npm install --save @nteract/mythic-rtc
```

## Usage

Bootstrap RTC by including the `collaboration` package and `collaborationMiddleware` in your store
and initializing it by dispatching the `init`  action:

```javascript
import { makeConfigureStore } from "@nteract/myths";
import { collaboration, collaborationMiddleware, initCollaboration } from "@nteract/mythic-rtc";

export const configureStore = makeConfigureStore({
  packages: [collaboration],
  epicMiddleware: [collaborationMiddleware],
});

store.dispatch(initCollaboration.create({ store, backend, contentRef }));
```

Then dispatch the join session action:

```javascript
import { joinSession } from "@nteract/mythic-rtc";

store.dispatch(joinSession.create({/* TBD */}));
```

Once connected to the backend the collaboration driver will start synchronizing Redux actions automatically.

## License

[BSD-3-Clause](https://choosealicense.com/licenses/bsd-3-clause/)

