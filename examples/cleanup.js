// Example of a second processor. Changes only the upload copy.
module.exports = async ({ content }) => {
    return content.replace(/<!--\s*obshare-private-start\s*-->[\s\S]*?<!--\s*obshare-private-end\s*-->/g, '');
};
