# Browsnex
Browsnex (browse-next) is a way to browse modern pages in old browsers

# Run
install the deps with npm install, and then run server.js

# What Makes Browsnex Different?
Basically instead of taking screenshots and rendering as PNG (slow) like Browservice (no shade guys, really cool thing!) It hooks into Chromium's CDP (the compositor)
and just serves the data straight and encodes it as an MJPEG stream. It also slows down the stream when nothing is happening, so only when motion is happening.
