const express = require("express");
const app = express();

app.use(express.static("web-portal"));

app.listen(process.env.PORT || 3000);
