/**
 * Datums whose coordinates this library places on WGS84 by applying no shift
 * at all, because that is what EPSG itself publishes for them (Decision 6).
 *
 * proj4 applies no datum shift to a WKT that does not state one. For a datum
 * aligned with WGS84 that is right, and for one that is not it is silently
 * wrong: measured against PROJ 9.8.1, Korean 1985 comes out 379 m off, DHDN
 * 160 m, Amersfoort 114 m. The ellipsoid cannot tell the two apart — VN-2000
 * sits on the WGS84 ellipsoid itself and is 225 m off. So the question is put
 * to EPSG instead: a datum is listed here when EPSG publishes a transformation
 * from it to WGS 84 whose parameters are all zero. A file on any other datum
 * has to be given its definition by the caller, with the shift written in.
 *
 * Measured over every non-deprecated EPSG projected and geographic 2D system
 * PROJ 9.8.1 could give a non-ballpark answer for (5,198): the 3,143 whose
 * datum is listed here all land within 1.35 m of PROJ through proj4 2.21 and
 * the file's own WKT. The largest gaps are NAD83 realizations (CSRS, HARN),
 * where EPSG publishes a zero transformation alongside the non-zero one PROJ
 * prefers. Of the 2,020 left out, 1,775 would have been further off than
 * PROJ's own stated accuracy.
 *
 * Generated from PROJ 9.8.1's proj.db (EPSG v12.029, 2025-10-02), with WGS 84
 * itself (6326) added because it needs no transformation to list:
 *
 *   SELECT DISTINCT g.datum_code FROM helmert_transformation h
 *   JOIN geodetic_crs g ON g.auth_name = h.source_crs_auth_name
 *                      AND g.code = h.source_crs_code
 *   WHERE h.auth_name = 'EPSG' AND h.deprecated = 0
 *     AND h.target_crs_auth_name = 'EPSG' AND h.target_crs_code = '4326'
 *     AND g.datum_auth_name = 'EPSG'
 *     AND COALESCE(h.tx, 0) = 0 AND COALESCE(h.ty, 0) = 0 AND COALESCE(h.tz, 0) = 0
 *     AND COALESCE(h.rx, 0) = 0 AND COALESCE(h.ry, 0) = 0 AND COALESCE(h.rz, 0) = 0
 *     AND COALESCE(h.scale_difference, 0) = 0;
 */
export const NULL_SHIFT_DATUMS: ReadonlySet<number> = new Set([
  1026, // Taiwan Datum 1997
  1029, // Iraqi Geospatial Reference System
  1032, // MOLDREF99
  1033, // Reseau Geodesique de la RDC 2005
  1034, // Serbian Reference Network 1998
  1035, // Red Geodesica de Canarias 1995
  1036, // Reseau Geodesique de Mayotte 2004
  1038, // Reseau Geodesique de Saint Pierre et Miquelon 2006
  1041, // Autonomous Regions of Portugal 2008
  1042, // Mexico ITRF92
  1047, // Reseau de Reference des Antilles Francaises 1991
  1056, // Geocentric Datum Brunei Darussalam 2009
  1057, // Turkish National Reference Frame
  1058, // Bhutan National Geodetic Datum
  1060, // Islands Net 2004
  1062, // Posiciones Geodesicas Argentinas 2007
  1063, // Marco Geodesico Nacional de Bolivia
  1065, // Costa Rica 2005
  1066, // Sistema Geodesico Nacional de Panama MACARIO SOLIS
  1067, // Peru96
  1068, // SIRGAS-ROU98
  1069, // SIRGAS_ES2007.8
  1073, // Reseau Geodesique des Antilles Francaises 2009
  1076, // Papua New Guinea Geodetic Datum 1994
  1078, // Fehmarnbelt Datum 2010
  1095, // Tonga Geodetic Datum 2005
  1100, // Cayman Islands Geodetic Datum 2011
  1113, // Reseau Geodesique des Terres Australes et Antarctiques Francaises 2007
  1116, // NAD83 (National Spatial Reference System 2011)
  1120, // Mexico ITRF2008
  1128, // Japanese Geodetic Datum 2011
  1132, // Rete Dinamica Nazionale 2008
  1147, // Oman National Geodetic Datum 2014
  1159, // Geodezicheskaya Sistema Koordinat 2011
  1160, // Kyrgyzstan Geodetic Datum 2006
  1167, // Bulgaria Geodetic System 2005
  1168, // Geocentric Datum of Australia 2020
  1174, // St. Helena Geodetic Datum 2015
  1187, // Islands Net 2016
  1208, // Macao Geodetic Datum 2008
  1209, // Hong Kong Geodetic
  1214, // Serbian Spatial Reference System 2000
  1218, // MOMRA Terrestrial Reference Frame 2000
  1220, // Reference System de Angola 2013
  1223, // Reseau Geodesique de Wallis et Futuna 1996
  1251, // Kosovo Reference System 2001
  1305, // ETRF2000 Poland
  1312, // Reseau Geodesique Francais 1993 v2
  1313, // Reseau Geodesique Francais 1993 v2b
  1329, // Marco Geocentrico Nacional de Referencia 2018
  1355, // Sonatrach Reference Frame 2020
  1356, // Latvian coordinate system 2020
  1357, // Reseau Geodesique de Nouvelle Caledonie 2015
  1358, // BH_ETRS89
  1367, // Brenner Base Tunnel 2000
  1380, // BES2020 Saba
  1389, // Mayotte Geodetic Reference Frame 2023
  1391, // EUREF-FIN
  1392, // Uzbekistan Geodetic Datum 2024
  1394, // BES2020 Sint Eustatius
  1397, // Bonaire 2004
  1401, // Uganda Geodetic Reference Frame
  1402, // Liberia Reference Frame 2021
  1407, // ETRS89-NOR [EUREF89]
  1414, // California Spatial Reference Network epoch 2025.0 (NAD83 2011)
  1417, // Kazakhstan Terrestrial Reference Frame 2023
  1421, // Greenland Reference 1996 ensemble
  1422, // North American Terrestrial Reference Frame of 2022
  6126, // Lithuania 1994 (ETRS89)
  6130, // Moznet (ITRF94)
  6140, // NAD83 Canadian Spatial Reference System
  6148, // Hartebeesthoek94
  6151, // Swiss Terrestrial Reference System 1995
  6152, // NAD83 (High Accuracy Reference Network)
  6163, // Yemen National Geodetic Network 1996
  6166, // Korean Datum 1995
  6167, // New Zealand Geodetic Datum 2000
  6170, // Sistema de Referencia Geocentrico para America del Sur 1995
  6171, // Reseau Geodesique Francais 1993 v1
  6173, // IRENET95
  6176, // Australian Antarctic Datum 1998
  6180, // Estonia 1997
  6189, // Red Geodesica Venezolana
  6190, // Posiciones Geodesicas Argentinas 1998
  6258, // European Terrestrial Reference System 1989 ensemble
  6269, // North American Datum 1983
  6283, // Geocentric Datum of Australia 1994
  6326, // World Geodetic System 1984 ensemble
  6612, // Japanese Geodetic Datum 2000
  6619, // SWEREF99
  6624, // Reseau Geodesique Francais Guyane 1995
  6627, // Reseau Geodesique de la Reunion 1992
  6659, // Islands Net 1993
  6661, // Latvian geodetic coordinate system 1992
  6667, // Iraq-Kuwait Boundary Datum 1992
  6670, // Istituto Geografico Militaire 1995
  6674, // Sistema de Referencia Geocentrico para las AmericaS 2000
  6686, // Marco Geocentrico Nacional de Referencia
  6687, // Reseau Geodesique de la Polynesie Francaise
  6694, // Posiciones Geodesicas Argentinas 1994
  6702, // Mauritania 1999
  6737, // Korean Geodetic Datum 2002
  6742, // Geodetic Datum of Malaysia 2000
  6749, // Reseau Geodesique de Nouvelle Caledonie 91-93
  6755, // Datum Geodesi Nasional 1995
  6757, // SVY21
  6758, // Jamaica 2001
  6759, // NAD83 (National Spatial Reference System 2007)
  6761, // Croatian Terrestrial Reference System
  6762, // Bermuda 2000
  6763, // Pitcairn 2006
  6764, // Ross Sea Region Geodetic Datum 2000
  6765, // Slovenia Geodetic Datum 1996
]);
