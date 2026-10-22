const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

function findTemplates(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findTemplates(entryPath);
    return entry.name.endsWith('.ejs') ? [entryPath] : [];
  });
}

for (const templatePath of findTemplates(path.join(__dirname, '..', 'views'))) {
  ejs.compile(fs.readFileSync(templatePath, 'utf8'), { filename: templatePath });
}

console.log('All EJS templates compiled successfully.');
