"use strict";

const sharp = require("sharp");

console.log(sharp.versions);
console.log("formats", sharp.format);


sharp("./test.heic").rotate().toFormat("jpg");
