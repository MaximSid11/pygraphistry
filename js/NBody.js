"use strict";

var Q = require('q');
var glMatrix = require('gl-matrix');
var events = require('./SimpleEvents.js');
var _ = require('underscore');
var debug = require("debug")("N-body:main");

var STEP_NUMBER_ON_CHANGE = 30;
var elementsPerPoint = 2;


/**
 * Create a new N-body graph and return a promise for the graph object
 *
 * @param simulator - the module of the simulator backend to use
 * @param renderer - the module of the rendering backend to use
 * @param document - parent document DOM
 * @param canvas - the canvas DOM element to draw the graph in
 * @param bgColor - [0--255,0--255,0--255,0--1]
 * @param [dimensions=\[1,1\]] - a two element array [width,height] used for internal posituin calculations.
 */
function create(simulator, renderer, document, canvas, bgColor, dimensions, numSplits) {
    dimensions = dimensions || [1,1];
    numSplits = numSplits || 0;

    return renderer
        .create(document, canvas, bgColor, dimensions)
        .then(function(rend) {
            debug("Created renderer");

            return simulator
                .create(rend, dimensions, numSplits)
                .then(function(sim) {
                    debug("Created simulator");

                    var graph = {
                        "renderer": rend,
                        "simulator": sim
                    };
                    graph.setPoints = setPoints.bind(this, graph);
                    graph.setVertices = setVertices.bind(this, graph);
                    graph.setSizes = setSizes.bind(this, graph);
                    graph.setColors = setColors.bind(this, graph);
                    graph.setEdges = setEdges.bind(this, graph);
                    graph.setEdges2 = setEdges2.bind(this, graph);
                    graph.setEdgeColors = setEdgeColors.bind(this, graph);
                    graph.setPhysics = setPhysics.bind(this, graph);
                    graph.setVisible = setVisible.bind(this, graph);
                    graph.setLocked = setLocked.bind(this, graph);
                    graph.setColorMap = setColorMap.bind(this, graph);
                    graph.tick = tick.bind(this, graph);
                    graph.stepNumber = 0;
                    graph.dimensions = dimensions;
                    graph.numSplits = numSplits;

                    graph.updateSettings = updateSettings.bind(this, graph);

                    return graph;
                });
        });
}


function updateSettings (graph, cfg) {
    graph.simulator.setPhysics(cfg);
    graph.simulator.setLocked(cfg);
    graph.renderer.setVisible(cfg);

    if (cfg.timeSubset) {
        graph.simulator.setTimeSubset(cfg.timeSubset);
    }
}

// TODO Deprecate and remove
function setPoints(graph, points, pointSizes, pointColors) {
    // FIXME: If there is already data loaded, we should to free it before loading new data
    return setVertices(graph, points)
    .then(function (simulator) {
        return setSizes(graph, pointSizes);        
    }).then(function (simulator) {
        return setColors(graph, pointColors);
    })
    .then(function() {
        return graph;
    }).catch(function (error) {
        console.error("ERROR Failure in NBody.setPoints ", error.stack);
    });
}

function setVertices(graph, points) {
    debug("Loading Vertices")
    if(!(points instanceof Float32Array)) {
        points = _toTypedArray(points, Float32Array);
    }

    graph.__pointsHostBuffer = points;

    graph.stepNumber = 0;
    return graph.simulator.setPoints(points)
}

function setSizes(graph, pointSizes) {
    if (!pointSizes)
        return setDefaultSizes(graph.simulator);

    debug("Loading pointSizes")
    var _pointSizes = new Uint8Array(graph.simulator.numPoints);
    var min = 0, max = Math.pow(2, 8) - 1;
    if (!_.all(pointSizes, function (s) {return s >= min && s <= max}))
        console.warn("WARNING Point size out of range, capping to 8 bits")
    for (var i = 0; i < graph.simulator.numPoints; i++)
        _pointSizes[i] = Math.min(max, Math.max(min, pointSizes[i]));
    return graph.simulator.setSizes(_pointSizes)
}

function setDefaultSizes(simulator) {
    debug("Using default node sizes");
    var pointSizes = new Uint8Array(simulator.numPoints);
    for (var i = 0; i < simulator.numPoints; i++)
        pointSizes[i] = 4;

    return simulator.setSizes(pointSizes);
}

function setColors(graph, pointColors) {
    if (!pointColors)
        return setDefaultColors(graph.simulator);

    console.error("ERROR TODO SET COLORS");
    process.abort();
}

function setDefaultColors(simulator) {
    debug("Using default node colors");
    var pointColors = new Uint32Array(simulator.numPoints);
    for (var i = 0; i < simulator.numPoints; i++)
        pointColors[i] = (255 << 24) | (102 << 16) | (102 << 8) | 255;

    return simulator.setColors(pointColors);
}

// TODO Deprecate and remove
function setEdges(graph, edges, edgeColors) {
    return setEdges2(graph, edges)
    .then(function () {
        setEdgeColors(graph, edgeColors)
    });
}

var setEdges2 = Q.promised(function(graph, edges) {
    debug("Loading Edges")
    if (edges.length < 1)
        return Q.fcall(function() { return graph; });

    if (!(edges instanceof Uint32Array)) {
        edges = _toTypedArray(edges, Uint32Array);
    }

    debug("Number of edges: %d", edges.length / 2)

    var edgesFlipped = new Uint32Array(edges.length);
    for (var i = 0; i < edges.length; i++)
        edgesFlipped[i] = edges[edges.length - 1 - i];


    //FIXME THIS SHOULD WORK BUT CRASHES SAFARI
    var encapsulate = function (edges) {

        //[[src idx, dest idx]]
        var edgeList = new Array(edges.length / 2);
        for (var i = 0; i < edges.length/2; i++)
            edgeList[i] = [edges[2 * i], edges[2 * i + 1]];

        //sort by src idx
        edgeList.sort(function(a, b) {
            return a[0] < b[0] ? -1
                : a[0] > b[0] ? 1
                : a[1] - b[1];
        });

        //[ [first edge number from src idx, numEdges from source idx, source idx], ... ]
        var workItems = [ [0, 1, edgeList[0][0]] ];
        var sourceHasEdge = {};
        edgeList.forEach(function (edge, i) {
            sourceHasEdge[edge[0]] = true;
        });
        edgeList.forEach(function (edge, i) {
            if (i == 0) return;
            var prev = workItems[workItems.length - 1];
            if(edge[0] == prev[2]) {
                prev[1]++;
            } else {
                workItems.push([i, 1, edge[0]])
            }
        });


        //DISABLED: keeping ordered to streamline time-based filtering
        /*
        //Cheesey load balancing: sort by size
        //TODO benchmark
        workItems.sort(function (edgeList1, edgeList2) {
            return edgeList1[1] - edgeList2[1];
        });
        */

        var degreesFlattened = new Uint32Array(graph.__pointsHostBuffer.length);
        //-1 signifies no item
        var srcToWorkItem = new Int32Array(graph.__pointsHostBuffer.length);
        workItems.forEach(function (edgeList, idx) {
            srcToWorkItem[edgeList[0]] = idx;
            degreesFlattened[edgeList[2]] = edgeList[1];
        });

        //Uint32Array [first edge number from src idx, number of edges from src idx]
        //fetch edge to find src and dst idx (all src same)
        //num edges > 0
        var workItemsFlattened =
            new Uint32Array(
                _.flatten(workItems.map(function (o) { return [o[0], o[1]]})));

        var edgesFlattened = new Uint32Array(_.flatten(edgeList));

        return {
            degreesTyped: degreesFlattened,
            edgesTyped: edgesFlattened,
            numWorkItems: workItemsFlattened.length,
            workItemsTyped: new Uint32Array(workItemsFlattened),
            srcToWorkItem: srcToWorkItem
        };
    }

    var forwardEdges = encapsulate(edges);
    var backwardsEdges = encapsulate(edgesFlipped);

    var nDim = graph.dimensions.length;
    var midPoints = new Float32Array((edges.length / 2) * graph.numSplits * nDim || 1);
    if (graph.numSplits) {
        for (var i = 0; i < edges.length; i+=2) {
            var src = edges[i];
            var dst = edges[i + 1];
            for (var d = 0; d < nDim; d++) {
                var start = graph.__pointsHostBuffer[src * nDim + d];
                var end = graph.__pointsHostBuffer[dst * nDim + d];
                var step = (end - start) / (graph.numSplits + 1);
                for (var q = 0; q < graph.numSplits; q++) {
                    midPoints[(i * graph.numSplits + q) * nDim + d] = start + step * (q + 1);
                }
            }
        }
    }
    debug("Number of control points, splits: %d, %d", edges.length * graph.numSplits, graph.numSplits);

    return graph.simulator.setEdges(forwardEdges, backwardsEdges, midPoints)
    .then(function() { 
        return graph; 
    }).fail(function (error) {
        console.error("ERROR Failure in NBody.setEdges ", error.stack);
    });
});

function setEdgeColors(graph, edgeColors) {
    debug("Loading edgeColors");
    return graph.simulator.setEdgeColors(edgeColors);
}

function setPhysics(graph, opts) {
    graph.stepNumber = STEP_NUMBER_ON_CHANGE;
    graph.simulator.setPhysics(opts);
}


function setVisible(graph, opts) {
    graph.renderer.setVisible(opts);
}


function setLocked(graph, opts) {
    //TODO reset step number?
    graph.simulator.setLocked(opts);
}


function setColorMap(graph, imageURL, maybeClusters) {
    return graph.renderer.setColorMap(imageURL, maybeClusters)
        .then(_.constant(graph));
}


// Turns an array of vec3's into a Float32Array with elementsPerPoint values for each element in
// the input array.
function _toTypedArray(array, cons) {
    var floats = new cons(array.length * elementsPerPoint);

    for(var i = 0; i < array.length; i++) {
        var ii = i * elementsPerPoint;
        floats[ii + 0] = array[i][0];
        floats[ii + 1] = array[i][1];
    }

    return floats;
}


function tick(graph) {
    events.fire("tickBegin");
    events.fire("simulateBegin");

    return graph.simulator.tick(graph.stepNumber++)
    .then(function() {
        events.fire("simulateEnd");
        events.fire("renderBegin");

        return graph.renderer.render();
    })
    .then(function() {
        events.fire("renderEnd");
        events.fire("tickEnd");

        return graph;
    });
}


module.exports = {
    "elementsPerPoint": elementsPerPoint,
    "create": create,
    "setPoints": setPoints,
    "setEdges": setEdges,
    "setColorMap": setColorMap,
    "tick": tick
};
