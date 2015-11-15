var log = require('./logger.js');

// Parers
var sm = require('./search-manager.js');

var ts = require('torrent-stream');
var torrents = [];
// Web server
var mime = require('mime');
var express = require('express');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var ios = require('socket.io-stream');
var rangeParser = require('range-parser');
var pump = require('pump');
var rimraf = require('rimraf');

// Start webserver
http.listen(process.argv[2]);
app.use(express.static('public'));

app.get('/watch',function(req,res){
	if(req.query.tid && req.query.fid){
		var tid = getTorrentIdByInfoHash(req.query.tid);
		var fid = req.query.fid;
		
		if(tid != null){
			if(torrents[tid].files.length > fid){
				var file = torrents[tid].files[fid];

				res.setHeader('Accept-Ranges','bytes');
				res.setHeader('Content-Type', mime.lookup(file.name));
				res.statusCode = 200;
				res.setHeader('transferMode.dlna.org','Streaming');
				res.setHeader('contentFeatures.dlna.org','DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000');
				if(req.headers.range){
					res.statusCode = 206;
					var range = rangeParser(file.length,req.headers.range)[0];
					res.setHeader('Content-Range','bytes '+range.start+'-'+range.end+'/'+file.length);
					res.setHeader('Content-Length',range.end-range.start+1);
				}else{
					res.setHeader('Content-Length',file.length);
				}
				if(req.method === 'HEAD'){res.end()};
				log.debug('Creating Read Stream');
				pump(file.createReadStream(range), res);
			}else{
				res.sendStatus(404).end();
			}
		}else{
			res.sendStatus(404).end();
		}
	}else{res.sendStatus(404).end();}
});


var search = io.of('/search').on('connection',function(socket){
	log.debug('/search connected');
	socket.on('tmdb:search',function(query){
		log.debug('Search received');
		sm.search(query,{},function(err,res){
			if(err){log.error(err);}
			socket.emit('tmdb:search',err,res);
		});
	});
	socket.on('tmdb:listSeasons',function(tmdbId){
		log.debug('Seasons request received');
		sm.listSeasons(tmdbId,function(err,res){
			socket.emit('tmdb:seasons',err,res);
		});
	});
	socket.on('tmdb:listEpisodes',function(name,tmdbId,seasonId){
		sm.listEpisodes(name,tmdbId,seasonId,{},function(err,res){
			socket.emit('tmdb:episodes',err,res);
		});
	});
});

var stream = io.of('/stream').on('connection',function(socket){
	log.debug('/stream connected');

	socket.on('start',function(magUri){
		log.debug('start requested');
		log.debug(socket.rooms);
		leaveAllRooms(socket,function(){
			log.debug(socket.rooms);
			socket.join(parseMagURI(magUri),function(){
				cleanUpTorrents();
				if(getTorrentIdByInfoHash(parseMagURI(magUri)) == null){
					var tor = ts(magUri);
					tor['infoHash'] = parseMagURI(magUri);
					log.debug('infoHash: '+tor['infoHash']);
					torrents.push(tor);
					tor.on('ready',function(){initTorrent(tor);});
				}
			});
		});
	});
	socket.on('disconnect',function(){
		cleanUpTorrents();
	});
});

function leaveAllRooms(socket,cb){
	if(socket.rooms.length > 0){
		socket.leave(socket.rooms[socket.rooms.length-1],function(err){
			if(err){log.error(err);}
			if(socket.rooms.length > 0){leaveAllRooms(soket,cb);}
			else{cb();}
		});
	}else{cb();}
}

function parseMagURI(magUri){
	return magUri.split("btih:")[1].split("&")[0].toLowerCase();
}


function initTorrent(torrent){

	log.debug('torrent added');

	//remove torrent if no one is watching
	if(io.nsps['/stream'].adapter.rooms[torrent.infoHash]){
		if(io.nsps['/stream'].adapter.rooms[torrent.infoHash].length == 0){
			log.debug('destroying torrent');
			torrent.destroy();
		}
	}

	var tid = getTorrentIdByInfoHash(torrent.infoHash);
	log.debug("tid: "+tid);

	//Find largest file in torrent
	var fid = 0;
	var len = 0;
	for(var i=0;i<torrent.files.length;i++){
		fid = (torrent.files[i].length > len)?i:fid;
		len = (torrent.files[i].length > len)?torrent.files[i].length:len;
	}
	log.debug('fid: '+fid);

	//Update clients with progress of torrent download
	torrent.on('download',function(){
		//stream.to(torrent.infoHash).emit('progress',{msg:"Streaming "+torrent.files[fid].name,progress:torrent.progress,downloaded:torrent.downloaded,speed:torrent.downloadSpeed()});
	});

	//Notify clients of url to stream from
	stream.to(torrent.infoHash).emit('play', 'watch?tid='+torrent.infoHash+'&fid='+fid);
}

function cleanUpTorrents(){
	for(var i=0;i<torrents.length;i++){
		if(io.nsps['/stream'].adapter.rooms[torrents[i].infoHash]){
			if(io.nsps['/stream'].adapter.rooms[torrents[i].infoHash].length == 0){
				rimraf('/tmp/webtorrent/'+torrents[i].infoHash+'*',function(err){log.debug('Remove: '+i+' '+err);});
				torrents[i].destroy();
				torrents.splice(i,1);
			}
		}else{
			rimraf('/tmp/webtorrent/'+torrents[i].infoHash+'*',function(err){log.debug('Remove: '+i+' '+err);});
			torrents[i].destroy();
			torrents.splice(i,1);
		}
	}
}

function getTorrentIdByInfoHash(infoHash){
	for(var i=0;i<torrents.length;i++){
		if(torrents[i].infoHash == infoHash){return i;}
	}
	return null;
}
