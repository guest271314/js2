globalThis.name = chrome.runtime.getManifest().short_name;
/*
globalThis.port = chrome.runtime.connectNative(globalThis.name);
let received = 0;
const expected = 209715 * 64;
port.onMessage.addListener((message) => {
  received += message.length;
  if (received === expected) console.log({ received, expected });
});
port.onDisconnect.addListener((p) => console.log(chrome.runtime.lastError));
port.postMessage(new Array(expected));
*/
chrome.runtime.onInstalled.addListener((reason) => {
  console.log(reason);
});
