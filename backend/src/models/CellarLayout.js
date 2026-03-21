const mongoose = require('mongoose');

const rackPlacementSchema = new mongoose.Schema({
  rack:     { type: mongoose.Schema.Types.ObjectId, ref: 'Rack', required: true },
  position: {
    x: { type: Number, default: 0, min: -100, max: 100 },
    y: { type: Number, default: 0, min: -10, max: 50 },
    z: { type: Number, default: 0, min: -100, max: 100 },
  },
  rotation: { type: Number, default: 0, enum: [0, 90, 180, 270] },
  wall:     { type: String, enum: ['north', 'south', 'east', 'west', 'floor', 'none'], default: 'none' },
  group:          { type: String, default: null, maxlength: 50 },
  widthOverride:  { type: Number, min: 0.1, max: 5 },  // metres, optional physical width
  depthOverride:  { type: Number, min: 0.1, max: 2 },  // metres, optional physical depth
  scaleOverride:  { type: Number, min: 0.5, max: 5 },  // uniform scale factor (x-rack)
}, { _id: false });

const cellarLayoutSchema = new mongoose.Schema({
  cellar: { type: mongoose.Schema.Types.ObjectId, ref: 'Cellar', required: true, unique: true },
  roomDimensions: {
    width:  { type: Number, default: 10, min: 2, max: 50 },
    depth:  { type: Number, default: 10, min: 2, max: 50 },
    height: { type: Number, default: 3,  min: 2, max: 10 },
  },
  rackPlacements: [rackPlacementSchema],
}, { timestamps: true });

module.exports = mongoose.model('CellarLayout', cellarLayoutSchema);
