const path = require('path');

const projectsRoot = path.win32.resolve('D:\\CLIROProjects');

function canonical(value) {
    return path.win32.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}

function isCliroProject(value) {
    if (typeof value !== 'string' || !path.win32.isAbsolute(value)) return false;
    const relative = path.win32.relative(projectsRoot, path.win32.resolve(value));
    return relative !== '' && relative !== '..' &&
        !relative.startsWith(`..${path.win32.sep}`) && !path.win32.isAbsolute(relative);
}

function isExactWorkspace(expected, actual) {
    return isCliroProject(expected) && isCliroProject(actual) && canonical(expected) === canonical(actual);
}

module.exports = { canonical, isCliroProject, isExactWorkspace };
