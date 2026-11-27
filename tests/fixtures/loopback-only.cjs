const http = require("node:http");
const https = require("node:https");

const requestHttp = http.request;
http.request = function (url, ...args) {
  const destination = new URL(url);
  if (destination.protocol !== "http:" || destination.hostname !== "127.0.0.1") {
    throw new Error("Synthetic CLI test blocks non-loopback upstream requests");
  }
  return requestHttp.call(this, url, ...args);
};

https.request = function () {
  throw new Error("Synthetic CLI test blocks external HTTPS requests");
};
