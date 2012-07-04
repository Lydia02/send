
/**
 * Module dependencies.
 */

var debug = require('debug')('send')
  , parseRange = require('range-parser')
  , Stream = require('stream')
  , mime = require('mime')
  , fresh = require('fresh')
  , path = require('path')
  , http = require('http')
  , fs = require('fs')
  , basename = path.basename
  , normalize = path.normalize
  , join = path.join
  , utils = require('./utils');

/**
 * Expose `send`.
 */

exports = module.exports = send;

/**
 * Expose mime module.
 */

exports.mime = mime;

/**
 * Return a `SendStream` for `path`.
 *
 * @param {String} path
 * @return {SendStream}
 * @api public
 */

function send(path) {
  return new SendStream(path);
}

/**
 * Initialize a `SendStream` with the given `path`.
 *
 * Events:
 *
 *  - `error` an error occurred
 *  - `stream` file streaming has started
 *  - `end` streaming has completed
 *  - `directory` a directory was requested
 *
 * @param {String} path
 * @api private
 */

function SendStream(path) {
  var self = this;
  this.path = path;
  this.maxage(0);
  this.hidden(false);
  this.index('index.html');
}

/**
 * Inherits from `Stream.prototype`.
 */

SendStream.prototype.__proto__ = Stream.prototype;

/**
 * Enable or disable "hidden" (dot) files.
 *
 * @param {Boolean} path
 * @return {SendStream}
 * @api public
 */

SendStream.prototype.hidden = function(val){
  debug('hidden %s', val);
  this._hidden = val;
  return this;
};

/**
 * Set index `path`, set to a falsy
 * value to disable index support.
 *
 * @param {String|Boolean} path
 * @return {SendStream}
 * @api public
 */

SendStream.prototype.index = function(path){
  debug('index %s', path);
  this._index = path;
  return this;
};

/**
 * Set root `path`.
 *
 * @param {String} path
 * @return {SendStream}
 * @api public
 */

SendStream.prototype.root = function(path){
  this._root = path;
  return this;
};

/**
 * Set max-age to `ms`.
 *
 * @param {Number} ms
 * @return {SendStream}
 * @api public
 */

SendStream.prototype.maxage = function(ms){
  if (Infinity == ms) ms = 60 * 60 * 24 * 365 * 1000;
  debug('max-age %d', ms);
  this._maxage = ms;
  return this;
};

/**
 * Emit error `status` and `msg`.
 *
 * @param {Number} status
 * @param {String} msg
 * @api private
 */

SendStream.prototype.error = function(status, msg){
  var err = new Error(msg);
  var res = this.res;
  err.status = status;

  if (this.listeners('error').length) {
    this.emit('error', err);
    return;
  }

  status = status || 500;
  res.statusCode = status;
  res.end(http.STATUS_CODES[status]);
};

/**
 * Check if the pathname is potentially malicious.
 *
 * @return {Boolean}
 * @api private
 */

SendStream.prototype.isMalicious = function(){
  return !this._root && ~this.path.indexOf('..');
};

/**
 * Check if the pathname ends with "/".
 *
 * @return {Boolean}
 * @api private
 */

SendStream.prototype.hasTrailingSlash = function(){
  return '/' == this.path[this.path.length - 1];
};

/**
 * Check if the basename leads with ".".
 *
 * @return {Boolean}
 * @api private
 */

SendStream.prototype.hasLeadingDot = function(){
  return '.' == basename(this.path)[0];
};

/**
 * Check if this is a conditional GET request.
 *
 * @return {Boolean}
 * @api private
 */

SendStream.prototype.isConditionalGET = function(){
  return this.req.headers['if-none-match']
    || this.req.headers['if-modified-since'];
};

/**
 * Strip content-* header fields.
 *
 * @api private
 */

SendStream.prototype.removeContentHeaderFields = function(){
  var res = this.res;
  Object.keys(res._headers).forEach(function(field){
    if (0 == field.indexOf('content')) {
      res.removeHeader(field);
    }
  });
};

/**
 * Respond with 304 not modified.
 *
 * @api private
 */

SendStream.prototype.notModified = function(){
  var res = this.res;
  debug('not modified');
  this.removeContentHeaderFields();
  res.statusCode = 304;
  res.end();
};

/**
 * Check if the request is cacheable, aka
 * responded with 2xx or 304 (see RFC 2616 section 14.2{5,6}).
 *
 * @return {Boolean}
 * @api private
 */

SendStream.prototype.isCachable = function(){
  var res = this.res;
  return (res.statusCode >= 200 && res.statusCode < 300) || 304 == res.statusCode;
};

/**
 * Handle stat() error.
 *
 * @param {Error} err
 * @api private
 */

SendStream.prototype.onStatError = function(err){
  var notfound = ['ENOENT', 'ENAMETOOLONG', 'ENOTDIR'];
  if (~notfound.indexOf(err.code)) return this.error(404, 'not found');
  this.error(500, err);
};

/**
 * Check if the cache is fresh.
 *
 * @return {Boolean}
 * @api private
 */

SendStream.prototype.isFresh = function(){
  return fresh(this.req.headers, this.res._headers);
};

/**
 * Pipe to `res.
 *
 * @param {Stream} res
 * @return {Stream} res
 * @api public
 */

SendStream.prototype.pipe = function(res){
  var self = this
    , args = arguments
    , path = this.path
    , root = this._root;

  // references
  this.res = res;
  this.req = res.socket.parser.incoming; // TODO: wtf?

  // invalid request uri
  path = utils.decode(path);
  if (-1 == path) return this.error(400, 'invalid request uri');

  // null byte(s)
  if (~path.indexOf('\0')) return this.error(400, 'invalid request uri');

  // join / normalize from optional root dir
  if (root) path = normalize(join(this._root, path));

  // ".." is malicious without "root"
  if (this.isMalicious()) return this.error(403, 'forbidden');

  // malicious path
  if (root && 0 != path.indexOf(root)) return this.error(403, 'forbidden');

  // hidden file support
  if (!this._hidden && this.hasLeadingDot()) return this.error(404, 'not found');

  // index file support
  if (this._index && this.hasTrailingSlash()) path += this._index;

  debug('stat "%s"', path);
  fs.stat(path, function(err, stat){
    if (err) return self.onStatError(err);
    if (stat.isDirectory()) return self.emit('directory', stat);
    self.send(path, stat);
  });

  return res;
};

/**
 * Transfer `path`.
 *
 * @param {String} path
 * @api public
 */

SendStream.prototype.send = function(path, stat){
  var options = {};
  var len = stat.size;
  var res = this.res;
  var req = this.req;
  var ranges = req.headers.range;

  // set header fields
  this.setHeader(stat);

  // set content-type
  this.type(path);

  // conditional GET support
  if (this.isConditionalGET()
    && this.isCachable()
    && this.isFresh()) {
    return this.notModified();
  }

  // Range support
  if (ranges) {
    ranges = parseRange(len, ranges);

    // unsatisfiable
    if (-1 == ranges) {
      res.setHeader('Content-Range', 'bytes */' + stat.size);
      return this.error(416, 'requested range not satisfiable');
    }

    // valid (syntactically invalid ranges are treated as a regular response)
    if (-2 != ranges) {
      options.start = ranges[0].start;
      options.end = ranges[0].end;

      // Content-Range
      len = options.end - options.start + 1;
      res.statusCode = 206;
      res.setHeader('Content-Range', 'bytes '
        + options.start
        + '-'
        + options.end
        + '/'
        + stat.size);
    }
  }

  // content-length
  res.setHeader('Content-Length', len);

  // HEAD support
  if ('HEAD' == req.method) return res.end();

  this.stream(path, options);
};

/**
 * Stream `path` to the response.
 *
 * @param {String} path
 * @param {Object} options
 * @api private
 */

SendStream.prototype.stream = function(path, options){
  var self = this;
  var res = this.res;
  var req = this.req;

  // pipe
  var stream = fs.createReadStream(path, options);
  this.emit('stream', stream);
  stream.pipe(res);

  // socket closed, done with the fd
  req.on('close', stream.destroy.bind(stream));

  // error handling code-smell
  stream.on('error', function(err){
    // no hope in responding
    if (res._header) {
      console.error(err.stack);
      req.destroy();
      return;
    }

    // 500
    err.status = 500;
    self.emit('error', err);
  });

  // end
  stream.on('end', function(){
    self.emit('end');
  });
};

/**
 * Set content-type based on `path`
 * if it hasn't been explicitly set.
 *
 * @param {String} path
 * @api public
 */

SendStream.prototype.type = function(path){
  var res = this.res;
  if (res.getHeader('Content-Type')) return;
  var type = mime.lookup(path);
  var charset = mime.charsets.lookup(type);
  debug('content-type %s', type);
  res.setHeader('Content-Type', type + (charset ? '; charset=' + charset : ''));
};

/**
 * Set reaponse header fields, most
 * fields may be pre-defined.
 *
 * @param {Object} stat
 * @api private
 */

SendStream.prototype.setHeader = function(stat){
  var res = this.res;
  res.setHeader('Accept-Ranges', 'bytes');
  if (!res.getHeader('ETag')) res.setHeader('ETag', utils.etag(stat));
  if (!res.getHeader('Date')) res.setHeader('Date', new Date().toUTCString());
  if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'public, max-age=' + (this._maxage / 1000));
  if (!res.getHeader('Last-Modified')) res.setHeader('Last-Modified', stat.mtime.toUTCString());
};