# Basic analysis
node findDeadCode.js ./src

# With detailed reasons why things are unused
node findDeadCode.js ./src --show-reasons

# Debug mode to see what's happening
node findDeadCode.js ./src --debug --show-reasons
