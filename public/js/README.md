# Browser source layout
Classic scripts load in the explicit order listed in index.html. Shared lexical globals remain in the browser global scope; do not add async or change to module scripts without updating their dependencies.

icons -> state -> api -> ui -> auth -> routing -> pages -> app.
app.js runs startup after every page has been defined. CSS is in ../css/app.css. No build step or dependencies were added. This first extraction preserves the original JavaScript body and CSS exactly, apart from a strict-mode directive at each script boundary.
