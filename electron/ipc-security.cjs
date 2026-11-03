function allowedSender(event, window, expectedURL) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === expectedURL);
}
module.exports = { allowedSender };
