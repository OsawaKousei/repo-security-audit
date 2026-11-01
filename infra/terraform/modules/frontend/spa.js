/* exported handler */
function handler(event) {
  var request = event.request
  var lastPart = request.uri.substring(request.uri.lastIndexOf('/') + 1)
  if (request.uri.endsWith('/') || lastPart.indexOf('.') === -1) {
    request.uri = '/index.html'
  }
  return request
}
