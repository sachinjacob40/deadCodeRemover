# Basic analysis
node findDeadCode.js ./src

# With detailed reasons why things are unused
node findDeadCode.js ./src --show-reasons

# Debug mode to see what's happening
node findDeadCode.js ./src --debug --show-reasons



# See what would be removed (default is dry-run)
node removeUnusedCode.js ./src

# With verbose output to see details
node removeUnusedCode.js ./src --verbose

# Remove unused code (creates backup by default)
node removeUnusedCode.js ./src --no-dry-run

# Remove with options
node removeUnusedCode.js ./src --no-dry-run --preserve-exports --verbose


# Keep exported items and types, no backup
node removeUnusedCode.js ./src --no-dry-run --preserve-exports --preserve-types --no-backup

# Verbose output with detailed logging
node removeUnusedCode.js ./src --no-dry-run --verbose

