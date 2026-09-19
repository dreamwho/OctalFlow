import fs from "fs";
import path from "path";

console.log("Current cwd:", process.cwd());
if (fs.existsSync(".local-data")) {
    console.log(".local-data entries:", fs.readdirSync(".local-data"));
} else {
    console.log(".local-data does not exist");
}
