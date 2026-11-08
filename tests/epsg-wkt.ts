/**
 * Coordinate systems as a writer stores them in a COPC file's WKT record:
 * WKT1, exactly as PROJ 9.8.1 writes each (`CRS.to_wkt('WKT1_GDAL')` in
 * pyproj 3.8.0) — the dialect Autzen's own PDAL-written record uses.
 *
 * Shared rather than inlined because several test files want the same
 * strings, and a copy that drifted would test a system nobody writes.
 */

/**
 * EPSG:4326, WGS 84 — geographic, so the WKT is a GEOGCS with no PROJCS around
 * it.
 */
export const WGS84_GEOGRAPHIC =
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]';

/**
 * EPSG:5186, KGD2002 / Central Belt 2010 — a current Korean system, on a datum
 * EPSG shifts to WGS 84 by zero.
 */
export const KGD2002_CENTRAL_BELT =
  'PROJCS["KGD2002 / Central Belt 2010",GEOGCS["KGD2002",DATUM["Korean_Geodetic_Datum_2002",SPHEROID["GRS 1980",6378137,298.257222101,AUTHORITY["EPSG","7019"]],AUTHORITY["EPSG","6737"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4737"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",38],PARAMETER["central_meridian",127],PARAMETER["scale_factor",1],PARAMETER["false_easting",200000],PARAMETER["false_northing",600000],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","5186"]]';

/**
 * EPSG:5174, Korean 1985 / Modified Central Belt — Bessel 1841, 379 m off WGS
 * 84 with no shift applied.
 */
export const KOREAN_1985_MODIFIED_CENTRAL_BELT =
  'PROJCS["Korean 1985 / Modified Central Belt",GEOGCS["Korean 1985",DATUM["Korean_Datum_1985",SPHEROID["Bessel 1841",6377397.155,299.1528128,AUTHORITY["EPSG","7004"]],AUTHORITY["EPSG","6162"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4162"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",38],PARAMETER["central_meridian",127.002890277778],PARAMETER["scale_factor",1],PARAMETER["false_easting",200000],PARAMETER["false_northing",500000],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","5174"]]';

/**
 * EPSG:3405, VN-2000 / UTM zone 48N — on the WGS 84 ellipsoid itself, yet 225 m
 * off with no shift applied: the ellipsoid cannot tell a trusted datum from an
 * untrusted one.
 */
export const VN2000_UTM_48N =
  'PROJCS["VN-2000 / UTM zone 48N",GEOGCS["VN-2000",DATUM["Vietnam_2000",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6756"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4756"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",105],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","3405"]]';

/**
 * EPSG:2046, Hartebeesthoek94 / Lo15 — a trusted datum in a projection proj4
 * 2.21 cannot read (Transverse Mercator, south orientated).
 */
export const HARTEBEESTHOEK94_LO15 =
  'PROJCS["Hartebeesthoek94 / Lo15",GEOGCS["Hartebeesthoek94",DATUM["Hartebeesthoek94",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6148"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4148"]],PROJECTION["Transverse_Mercator_South_Orientated"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",15],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","2046"]]';
