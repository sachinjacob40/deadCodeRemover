import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class UnusedCodeDetector {
  constructor(projectPath, tsConfigPath) {
    this.projectPath = projectPath;
    this.declarations = new Map(); // What's declared
    this.imports = new Map(); // What's imported from other files
    this.usages = new Set(); // What's used within files
    this.exports = new Map(); // What's exported
    this.debug = false;

    console.log(`🔍 Starting analysis in: ${path.resolve(projectPath)}`);

    const configPath = tsConfigPath || this.findTsConfig(projectPath);
    console.log(`📋 Using TypeScript config: ${configPath}`);

    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) {
      throw new Error(
        `Error reading tsconfig.json: ${configFile.error.messageText}`
      );
    }

    const parsedConfig = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(configPath)
    );

    console.log(
      `📁 Found ${parsedConfig.fileNames.length} files in TypeScript project`
    );

    this.program = ts.createProgram({
      rootNames: parsedConfig.fileNames,
      options: parsedConfig.options,
      host: ts.createCompilerHost(parsedConfig.options)
    });

    this.checker = this.program.getTypeChecker();
    this.sourceFiles = this.program
      .getSourceFiles()
      .filter(
        (file) => !file.isDeclarationFile && !file.fileName.includes('node_modules')
      );

    console.log(`🔢 Analyzing ${this.sourceFiles.length} source files`);
  }

  findTsConfig(projectPath) {
    let currentDir = path.resolve(projectPath);

    while (currentDir !== path.dirname(currentDir)) {
      const tsConfigPath = path.join(currentDir, 'tsconfig.json');
      if (fs.existsSync(tsConfigPath)) {
        return tsConfigPath;
      }
      currentDir = path.dirname(currentDir);
    }

    throw new Error(
      `tsconfig.json not found in ${projectPath} or any parent directory`
    );
  }

  analyze() {
    try {
      console.log(`\n🔍 Phase 1: Collecting declarations...`);
      this.sourceFiles.forEach((file) => this.collectDeclarations(file));
      console.log(`📊 Found ${this.declarations.size} declarations`);

      console.log(`\n🔍 Phase 2: Tracking imports...`);
      this.sourceFiles.forEach((file) => this.trackImports(file));
      console.log(`📊 Found ${this.imports.size} imports`);

      console.log(`\n🔍 Phase 3: Finding internal usages...`);
      this.sourceFiles.forEach((file) => this.findUsages(file));
      console.log(`📊 Found ${this.usages.size} internal usages`);

      console.log(`\n🔍 Phase 4: Tracking exports...`);
      this.sourceFiles.forEach((file) => this.trackExports(file));
      console.log(`📊 Found ${this.exports.size} exports`);

      console.log(`\n🔍 Phase 5: Analyzing usage patterns...`);
      const unused = [];

      this.declarations.forEach((declaration, name) => {
        const isInternallyUsed = this.usages.has(name);
        const isImported = this.isNameImported(name, declaration.file);
        const isExported = this.exports.has(name);
        const isBuiltin = this.isInBuiltinTypes(name);

        if (this.debug) {
          console.log(`\n📋 Analyzing: ${name}`);
          console.log(`  - File: ${path.basename(declaration.file)}`);
          console.log(`  - Type: ${declaration.type}`);
          console.log(`  - Internally used: ${isInternallyUsed}`);
          console.log(`  - Imported by others: ${isImported}`);
          console.log(`  - Exported: ${isExported}`);
          console.log(`  - Builtin: ${isBuiltin}`);
        }

        // Something is unused if:
        // 1. It's not used internally in its own file/project
        // 2. It's not imported by any other file (even if exported)
        // 3. It's not a builtin type
        // 4. Exception: If it's exported AND the file is likely an entry point, we keep it
        const isLikelyEntryPoint = this.isLikelyEntryPoint(declaration.file);

        if (!isInternallyUsed && !isImported && !isBuiltin) {
          // Even exported items can be unused if no one imports them
          if (!isExported || !isLikelyEntryPoint) {
            const sourceFile = declaration.node.getSourceFile();
            const { line } = sourceFile.getLineAndCharacterOfPosition(
              declaration.node.getStart()
            );

            unused.push({
              name,
              type: declaration.type,
              file: sourceFile.fileName,
              line: line + 1,
              exported: isExported,
              reason: this.getUnusedReason(
                isInternallyUsed,
                isImported,
                isExported,
                isLikelyEntryPoint
              )
            });
          }
        }
      });

      return unused;
    } catch (error) {
      console.error('❌ Error during analysis:', error);
      return [];
    }
  }

  collectDeclarations(sourceFile) {
    let declarationCount = 0;

    const visit = (node) => {
      try {
        // Variables (const, let, var)
        if (ts.isVariableStatement(node)) {
          node.declarationList.declarations.forEach((decl) => {
            if (decl.name && ts.isIdentifier(decl.name)) {
              const flags = node.declarationList.flags;
              let type = 'variable';
              if (flags & ts.NodeFlags.Const) type = 'constant';

              this.declarations.set(decl.name.text, {
                file: sourceFile.fileName,
                node: decl,
                type
              });
              declarationCount++;
            }
          });
        }

        // Function declarations
        if (ts.isFunctionDeclaration(node) && node.name) {
          this.declarations.set(node.name.text, {
            file: sourceFile.fileName,
            node,
            type: 'function'
          });
          declarationCount++;
        }

        // Arrow functions and function expressions
        if (
          ts.isVariableDeclaration(node) &&
          node.initializer &&
          (ts.isArrowFunction(node.initializer) ||
            ts.isFunctionExpression(node.initializer)) &&
          ts.isIdentifier(node.name)
        ) {
          this.declarations.set(node.name.text, {
            file: sourceFile.fileName,
            node,
            type: 'function'
          });
          declarationCount++;
        }

        // Type aliases and interfaces
        if (ts.isTypeAliasDeclaration(node)) {
          this.declarations.set(node.name.text, {
            file: sourceFile.fileName,
            node,
            type: 'type'
          });
          declarationCount++;
        }

        if (ts.isInterfaceDeclaration(node)) {
          this.declarations.set(node.name.text, {
            file: sourceFile.fileName,
            node,
            type: 'interface'
          });
          declarationCount++;
        }

        // Classes and enums
        if (ts.isClassDeclaration(node) && node.name) {
          this.declarations.set(node.name.text, {
            file: sourceFile.fileName,
            node,
            type: 'class'
          });
          declarationCount++;
        }

        if (ts.isEnumDeclaration(node)) {
          this.declarations.set(node.name.text, {
            file: sourceFile.fileName,
            node,
            type: 'enum'
          });
          declarationCount++;
        }

        ts.forEachChild(node, visit);
      } catch (error) {
        console.warn(`⚠️ Error processing node in ${sourceFile.fileName}:`, error);
      }
    };

    visit(sourceFile);

    if (declarationCount > 0 && this.debug) {
      console.log(
        `📁 ${path.basename(sourceFile.fileName)}: ${declarationCount} declarations`
      );
    }
  }

  trackImports(sourceFile) {
    const visit = (node) => {
      // Track named imports: import { something } from './file'
      if (ts.isImportDeclaration(node) && node.importClause) {
        if (
          node.importClause.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings)
        ) {
          node.importClause.namedBindings.elements.forEach((element) => {
            if (ts.isIdentifier(element.name)) {
              this.imports.set(element.name.text, {
                from: node.moduleSpecifier.text,
                file: sourceFile.fileName,
                type: 'named'
              });

              if (this.debug) {
                console.log(
                  `📥 Import: ${element.name.text} from ${
                    node.moduleSpecifier.text
                  } in ${path.basename(sourceFile.fileName)}`
                );
              }
            }
          });
        }

        // Track default imports: import Something from './file'
        if (node.importClause.name) {
          this.imports.set(node.importClause.name.text, {
            from: node.moduleSpecifier.text,
            file: sourceFile.fileName,
            type: 'default'
          });

          if (this.debug) {
            console.log(
              `📥 Default import: ${node.importClause.name.text} from ${
                node.moduleSpecifier.text
              } in ${path.basename(sourceFile.fileName)}`
            );
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  findUsages(sourceFile) {
    let usageCount = 0;

    const visit = (node) => {
      try {
        // Skip declaration contexts
        if (this.isDeclarationContext(node)) {
          return;
        }

        // Identifier references
        if (ts.isIdentifier(node)) {
          this.usages.add(node.text);
          usageCount++;

          if (this.debug && usageCount < 10) {
            console.log(
              `🔗 Usage: ${node.text} in ${path.basename(sourceFile.fileName)}`
            );
          }
        }

        // Type references
        if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
          this.usages.add(node.typeName.text);
          usageCount++;
        }

        // JSX elements
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tagName = node.tagName;
          if (ts.isIdentifier(tagName)) {
            this.usages.add(tagName.text);
            usageCount++;
          }
        }

        // Call expressions
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          this.usages.add(node.expression.text);
          usageCount++;
        }

        ts.forEachChild(node, visit);
      } catch (error) {
        console.warn(`⚠️ Error processing usage in ${sourceFile.fileName}:`, error);
      }
    };

    visit(sourceFile);
  }

  trackExports(sourceFile) {
    const visit = (node) => {
      // Track exported declarations
      if (ts.canHaveModifiers(node)) {
        const modifiers = ts.getModifiers(node);
        if (
          modifiers &&
          modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        ) {
          this.markAsExported(node, sourceFile);
        }
      }

      // Track export statements
      if (
        ts.isExportDeclaration(node) &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause)
      ) {
        node.exportClause.elements.forEach((element) => {
          if (ts.isIdentifier(element.name)) {
            this.exports.set(element.name.text, {
              file: sourceFile.fileName,
              type: 'named'
            });

            if (this.debug) {
              console.log(
                `📤 Export: ${element.name.text} from ${path.basename(
                  sourceFile.fileName
                )}`
              );
            }
          }
        });
      }

      // Track export default
      if (
        ts.isExportAssignment(node) &&
        node.expression &&
        ts.isIdentifier(node.expression)
      ) {
        this.exports.set(node.expression.text, {
          file: sourceFile.fileName,
          type: 'default'
        });

        if (this.debug) {
          console.log(
            `📤 Default export: ${node.expression.text} from ${path.basename(
              sourceFile.fileName
            )}`
          );
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  markAsExported(node, sourceFile) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      this.exports.set(node.name.text, {
        file: sourceFile.fileName,
        type: 'function'
      });
    } else if (ts.isClassDeclaration(node) && node.name) {
      this.exports.set(node.name.text, { file: sourceFile.fileName, type: 'class' });
    } else if (ts.isInterfaceDeclaration(node)) {
      this.exports.set(node.name.text, {
        file: sourceFile.fileName,
        type: 'interface'
      });
    } else if (ts.isTypeAliasDeclaration(node)) {
      this.exports.set(node.name.text, { file: sourceFile.fileName, type: 'type' });
    } else if (ts.isVariableStatement(node)) {
      node.declarationList.declarations.forEach((decl) => {
        if (decl.name && ts.isIdentifier(decl.name)) {
          this.exports.set(decl.name.text, {
            file: sourceFile.fileName,
            type: 'variable'
          });
        }
      });
    }
  }

  isDeclarationContext(node) {
    const parent = node.parent;
    if (!parent) return false;

    if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
    if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
    if (ts.isClassDeclaration(parent) && parent.name === node) return true;
    if (ts.isInterfaceDeclaration(parent) && parent.name === node) return true;
    if (ts.isTypeAliasDeclaration(parent) && parent.name === node) return true;
    if (ts.isEnumDeclaration(parent) && parent.name === node) return true;
    if (ts.isParameter(parent) && parent.name === node) return true;
    if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
    if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
    if (ts.isImportSpecifier(parent) && parent.name === node) return true;

    return false;
  }

  isNameImported(name, fromFile) {
    // Check if any file imports this name from the given file
    for (const [importedName, importInfo] of this.imports) {
      if (importedName === name) {
        // Check if the import is from the same file (relative paths)
        const importFrom = importInfo.from;
        const declaredFile = fromFile;

        // Handle relative imports
        if (importFrom.startsWith('./') || importFrom.startsWith('../')) {
          const resolvedImportPath = path.resolve(
            path.dirname(importInfo.file),
            importFrom
          );
          const resolvedDeclPath = declaredFile.replace(/\.(ts|tsx|js|jsx)$/, '');

          if (resolvedImportPath === resolvedDeclPath) {
            return true;
          }
        }
      }
    }
    return false;
  }

  isLikelyEntryPoint(file) {
    const basename = path.basename(file, path.extname(file));
    const dirname = path.basename(path.dirname(file));

    // Common entry point patterns
    const entryPatterns = ['index', 'main', 'app', 'entry', 'bootstrap'];

    return (
      entryPatterns.includes(basename.toLowerCase()) ||
      (dirname === 'src' && basename === 'index')
    );
  }

  getUnusedReason(isInternallyUsed, isImported, isExported, isLikelyEntryPoint) {
    if (!isInternallyUsed && !isImported && !isExported) {
      return 'Not used anywhere and not exported';
    }
    if (!isInternallyUsed && !isImported && isExported && !isLikelyEntryPoint) {
      return 'Exported but never imported by any file';
    }
    if (!isInternallyUsed && !isImported && isExported && isLikelyEntryPoint) {
      return 'Exported from entry point but analysis incomplete';
    }
    return 'Unknown';
  }

  isInBuiltinTypes(name) {
    const builtinTypes = new Set([
      'Array',
      'Boolean',
      'Date',
      'Error',
      'Function',
      'Number',
      'Object',
      'RegExp',
      'String',
      'Symbol',
      'Promise',
      'Map',
      'Set',
      'WeakMap',
      'WeakSet',
      'React',
      'ReactNode',
      'ReactElement',
      'Component',
      'FC',
      'FunctionComponent',
      'console',
      'window',
      'document',
      'process',
      'global',
      'setTimeout',
      'setInterval',
      'clearTimeout',
      'clearInterval',
      'require',
      'exports',
      'module',
      '__dirname',
      '__filename'
    ]);
    return builtinTypes.has(name);
  }

  enableDebug() {
    this.debug = true;
    console.log('🐛 Debug mode enabled');
  }
}

// Main analysis function
async function findUnusedCode(projectPath, tsConfigPath, options = {}) {
  try {
    console.log(`🚀 Starting unused code analysis...`);
    console.log(`📍 Project path: ${path.resolve(projectPath)}`);
    console.log(`🔧 Node.js version: ${process.version}`);

    const detector = new UnusedCodeDetector(projectPath, tsConfigPath);

    if (options.debug) {
      detector.enableDebug();
    }

    const unused = detector.analyze();

    console.log(`\n📊 Analysis Results:`);
    console.log(`- Declarations found: ${detector.declarations.size}`);
    console.log(`- Imports tracked: ${detector.imports.size}`);
    console.log(`- Exports tracked: ${detector.exports.size}`);
    console.log(`- Internal usages found: ${detector.usages.size}`);
    console.log(`- Unused items: ${unused.length}`);

    if (unused.length === 0) {
      console.log('\n✅ No unused code found! Your project is clean.');
      return;
    }

    console.log(`\n⚠️  Found ${unused.length} potentially unused items:\n`);

    // Group by type
    const grouped = unused.reduce((acc, item) => {
      if (!acc[item.type]) acc[item.type] = [];
      acc[item.type].push(item);
      return acc;
    }, {});

    // Display results with reasons
    Object.entries(grouped).forEach(([type, items]) => {
      console.log(`\n${type.toUpperCase()}S (${items.length}):`);
      items.forEach((item) => {
        const relativePath = path.relative(process.cwd(), item.file);
        const exportedStr = item.exported ? ' [EXPORTED]' : '';
        console.log(`  • ${item.name}${exportedStr} - ${relativePath}:${item.line}`);
        if (options.showReasons) {
          console.log(`    Reason: ${item.reason}`);
        }
      });
    });

    // Save detailed report
    const outputPath = path.join(projectPath, 'unused-code-report.json');
    const report = {
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      projectPath: path.resolve(projectPath),
      totalUnused: unused.length,
      totalDeclarations: detector.declarations.size,
      totalImports: detector.imports.size,
      totalExports: detector.exports.size,
      totalUsages: detector.usages.size,
      byType: grouped,
      items: unused,
      allDeclarations: options.includeDetails
        ? Array.from(detector.declarations.entries())
        : undefined,
      allImports: options.includeDetails
        ? Array.from(detector.imports.entries())
        : undefined,
      allExports: options.includeDetails
        ? Array.from(detector.exports.entries())
        : undefined,
      allUsages: options.includeDetails ? Array.from(detector.usages) : undefined
    };

    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(
      `\n📄 Detailed report saved to: ${path.relative(process.cwd(), outputPath)}`
    );
  } catch (error) {
    console.error('\n❌ Error analyzing code:', error);
    process.exit(1);
  }
}

// CLI interface
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node findDeadCode.js [PROJECT_PATH] [TSCONFIG_PATH] [OPTIONS]

Options:
  PROJECT_PATH       Path to your project (default: current directory)
  TSCONFIG_PATH      Path to tsconfig.json (optional)
  --debug            Enable debug mode for verbose output
  --show-reasons     Show why each item is considered unused
  --include-details  Include all declarations and usages in report
  --help, -h         Show this help message

Examples:
  node findDeadCode.js
  node findDeadCode.js ./src
  node findDeadCode.js ./src ./tsconfig.json
  node findDeadCode.js ./src --debug --show-reasons
  `);
  process.exit(0);
}

const projectPath = args.find((arg) => !arg.startsWith('--')) || process.cwd();
const tsConfigPath = args.find(
  (arg, index) =>
    index > 0 &&
    !arg.startsWith('--') &&
    args[index - 1] &&
    !args[index - 1].startsWith('--')
);
const options = {
  debug: args.includes('--debug'),
  showReasons: args.includes('--show-reasons'),
  includeDetails: args.includes('--include-details')
};

// Check if the project path exists
if (!fs.existsSync(projectPath)) {
  console.error(`❌ Project path does not exist: ${projectPath}`);
  process.exit(1);
}

findUnusedCode(projectPath, tsConfigPath, options);

export { UnusedCodeDetector, findUnusedCode };
