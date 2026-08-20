import { CopcTilesetError } from './base.js';

/**
 * No horizontal EPSG code could be read from the file's WKT.
 *
 * Unlike an unregistered code, there is nothing for the caller to register —
 * the file did not say which system its coordinates are in, so the file is what
 * has to change.
 */
export class CrsCodeNotFoundError extends CopcTilesetError {
  readonly code = 'crs-code-not-found';

  constructor() {
    super(
      'No horizontal EPSG code could be read from this file\'s coordinate system ' +
        'description. Its WKT either names no authority or names one this library does ' +
        'not recognise, so there is nothing to look up. Re-writing the file with a ' +
        'current PDAL — `pdal translate input.laz output.copc.laz --writers.copc.a_srs=EPSG:<code>` ' +
        '— will record a system that can be read.',
    );
  }
}

/**
 * The file names a coordinate system nobody registered.
 *
 * Decision 6 registers only EPSG:4326 by default, because there is no
 * predicting which systems arrive and a partial built-in table would be worse
 * than one clear rule. The message therefore has to do the work: it carries the
 * code the file asked for, already inside the call that fixes it.
 */
export class CrsNotRegisteredError extends CopcTilesetError {
  readonly code = 'crs-not-registered';
  readonly epsgCode: number;

  constructor(epsgCode: number) {
    super(
      `This file uses EPSG:${epsgCode}, which is not registered. Only EPSG:4326 is ` +
        'known by default, so every other system has to be supplied once, before the ' +
        'file is opened:\n\n' +
        `    registerCrs(${epsgCode}, '<proj4 definition>');\n\n` +
        `The definition for EPSG:${epsgCode} is at https://epsg.io/${epsgCode} — take ` +
        'its proj4 string. Its accuracy is yours to vouch for; this library only ' +
        'applies what it is given.',
    );
    this.epsgCode = epsgCode;
  }
}
