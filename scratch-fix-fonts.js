const fs = require('fs');
const path = require('path');

function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach(f => {
    let dirPath = path.join(dir, f);
    let isDirectory = fs.statSync(dirPath).isDirectory();
    isDirectory ? walkDir(dirPath, callback) : callback(path.join(dir, f));
  });
}

walkDir('./src', (filePath) => {
  if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) {
    let content = fs.readFileSync(filePath, 'utf8');
    let changed = false;

    // Find className="..." inside <Text> or <TextInput>
    // This regex looks for className="something" and replaces font-bold with font-nataBold etc
    // and adds font-nata if no font-nata is present.
    // It's safer to use a function.
    content = content.replace(/(<(?:Text|TextInput)[^>]*?className=(["']))([^"']+)\2/g, (match, p1, quote, classNames) => {
      let classes = classNames.split(' ').filter(c => c.trim() !== '');
      let newClasses = [...classes];

      let hasFontNata = classes.some(c => c.startsWith('font-nata'));
      let hasFontBold = classes.includes('font-bold');
      let hasFontSemibold = classes.includes('font-semibold');

      if (!hasFontNata && !hasFontBold && !hasFontSemibold) {
        newClasses.push('font-nata');
      }

      if (hasFontBold) {
        newClasses = newClasses.filter(c => c !== 'font-bold');
        if (!classes.some(c => c === 'font-nataBold')) {
          newClasses.push('font-nataBold');
        }
      }

      if (hasFontSemibold) {
        newClasses = newClasses.filter(c => c !== 'font-semibold');
        if (!classes.some(c => c === 'font-nataSemiBold')) {
          newClasses.push('font-nataSemiBold');
        }
      }

      const newClassNameStr = newClasses.join(' ');
      if (newClassNameStr !== classNames) {
        changed = true;
        return `${p1}${newClassNameStr}${quote}`;
      }
      return match;
    });

    // Also look for <Text> tags that don't have className at all
    content = content.replace(/<(Text|TextInput)(?![^>]*className=)([^>]*)>/g, (match, tag, rest) => {
      // Check if it's self-closing or not, and avoid replacing if it already has font-nata in style (though we prefer className)
      // Just add className="font-nata" before the closing bracket
      changed = true;
      if (rest.endsWith('/')) {
         return `<${tag} className="font-nata"${rest.slice(0, -1)} />`;
      }
      return `<${tag} className="font-nata"${rest}>`;
    });


    if (changed) {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log('Updated', filePath);
    }
  }
});
