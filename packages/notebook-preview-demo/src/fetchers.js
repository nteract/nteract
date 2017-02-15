function frozenReviver(key, value) {
  return Object.freeze(value);
}

function createFrozenNotebook(text) {
  return JSON.parse(text, frozenReviver);
}

/**
 * fetch notebook JSON from
 * @param  {[type]} gistId [description]
 * @return {[type]}        [description]
 */
export function fetchFromGist(gistId) {
  var path = `https://api.github.com/gists/${gistId}`;
  return fetch(path)
    .then((data) => data.json())
    .then((ghResponse) => {
      for (var file in ghResponse.files) {
        if (/.ipynb$/.test(file)) {
          const fileResponse = ghResponse.files[file];
          if (fileResponse.truncated) {
            return fetch(fileResponse.raw_url)
                    .then((resp) => resp.text())
                    .then(createFrozenNotebook)
          }
          return createFrozenNotebook(fileResponse.content);
        }
      }
    })
}
