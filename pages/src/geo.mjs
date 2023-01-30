import * as sauce from '../../shared/sauce/index.mjs';
import * as common from './common.mjs';
import {Color} from './color.mjs';
import * as ec from '../deps/src/echarts.mjs';
import * as theme from './echarts-sauce-theme.mjs';

ec.registerTheme('sauce', theme.getTheme('dynamic'));

const L = sauce.locale;
const H = L.human;
let imperial = !!common.storage.get('/imperialUnits');
L.setImperial(imperial);
const gettingWorldList = common.getWorldList();


function vectorDistance(a, b) {
    const xd = b[0] - a[0];
    const yd = b[1] - a[1];
    const zd = b[2] - a[2];
    return Math.sqrt(xd * xd + yd * yd + zd * zd);
}


async function createElevationProfile(renderer) {
    const chart = ec.init(document.querySelector('#content .elevation-profile'), 'sauce',
        {renderer: 'svg'});
    chart.setOption({
        tooltip: {
            trigger: 'axis',
            formatter: ([{value}]) => value ?
                `${H.elevation(value[1], {suffix: true})}\n${H.number(value[2] * 100, {suffix: '%'})}` : '',
            axisPointer: {
                z: -1,
            },
        },
        xAxis: {
            type: 'value',
            boundaryGap: false,
            show: false,
            min: 'dataMin',
            max: 'dataMax',
        },
        dataZoom: [{
            type: 'inside',
        }],
        yAxis: {
            show: false,
            type: 'value',
            min: x => Math.max(0, x.min - 20),
            max: x => Math.max(x.max, x.min + 200),
        },
        series: [{
            name: 'Elevation',
            smooth: 0.5,
            type: 'line',
            symbol: 'none',
            areaStyle: {},
            encode: {
                x: 0,
                y: 1,
                tooltip: [0, 1, 2]
            },
            markLine: {
                symbol: 'none',
                silent: true,
                label: {
                    position: 'start',
                    distance: 10,
                    formatter: x => H.elevation(x.value, {suffix: true}),
                    fontSize: '0.5em',
                },
                lineStyle: {
                },
                data: [{
                    type: 'min',
                }, {
                    type: 'max',
                }]
            }
        }]
    });
    let courseId;
    let roads;
    let road;
    let reverse;
    let markAnimationDuration;
    const worldList = await gettingWorldList;
    renderer.addCallback(async _nearby => {
        if (!_nearby || !_nearby.length) {
            return;
        }
        const nearby = Array.from(_nearby);
        nearby.sort((a, b) => a.athleteId - b.athleteId);  // stablize by athlete not gap.
        nearby.sort((a, b) => a.watching ? 1 : b.watching ? -1 : 0); // put Watching mark on top
        const watching = nearby.find(x => x.watching);
        if (watching.state.courseId !== courseId) {
            courseId = watching.state.courseId;
            road = null;
            const worldId = worldList.find(x => x.courseId === courseId).worldId;
            roads = await common.getRoads(worldId);
        }
        if (!road || watching.state.roadId !== road.id || reverse !== watching.state.reverse) {
            road = roads[watching.state.roadId];
            reverse = watching.state.reverse;
            chart.setOption({xAxis: {inverse: reverse}});
            // XXX 200 when done validating
            markAnimationDuration = 20; // reset so render is not uber-slow
            const distance = road.distances[road.distances.length - 1];
            chart.setOption({series: [{
                areaStyle: {
                    color:  {
                        type: 'linear',
                        x: reverse ? 1 : 0,
                        y: 0,
                        x2: reverse ? 0 : 1,
                        y2: 0,
                        colorStops: road.distances.map((x, i) => ({
                            offset: x / distance,
                            color: Color.fromRGB(Math.abs(road.grades[i] / 0.10), 0, 0.15, 0.95).toString(),
                            //color: new Color(0.33 - Math.min(1, Math.abs(road.grades[i] / 0.10)) * (120 / 360), 0.5, 0.5, 0.95).toString(),
                        })),
                    },
                },
                data: road.distances.map((x, i) =>
                    [x, road.elevations[i], road.grades[i] * (reverse ? -1 : 1)]),
            }]});
        }
        const markEmphasisLabel = params => {
            if (!params || !params.data || !params.data.name) {
                return;
            }
            const data = nearby.find(x => x.athleteId === params.data.name);
            if (!data) {
                return;
            }
            const items = [
                data.athlete && data.athlete.fLast,
                data.stats.power.smooth[5] != null ? H.power(data.stats.power.smooth[5], {suffix: true}) : null,
                data.state.heartrate ? H.number(data.state.heartrate, {suffix: 'bpm'}) : null,
                data.gap ? H.duration(data.gap, {short: true, seperator: ' '}) : null,
            ];
            return items.filter(x => x != null).join(', ');
        };
        chart.setOption({series: [{
            markPoint: {
                itemStyle: {borderColor: '#000'},
                animationDurationUpdate: markAnimationDuration,
                animationEasingUpdate: 'linear',
                data: nearby.filter(x => x.state.roadId === road.id && x.state.reverse === reverse).map(x => {
                    // XXX
                    const distances = road.coords.map(c => vectorDistance(c, [x.state.x, x.state.y, x.state.z]));
                    const nearest = distances.indexOf(Math.min(...distances));
                    const distance = road.distances[nearest];
                    if (x.watching) {
                        //console.log(nearest, distance, distances);
                    }
                    return {
                        name: x.athleteId,
                        coord: [distance, x.state.altitude + 2],
                        symbolSize: x.watching ? 40 : 20,
                        itemStyle: {
                            color: x.watching ? '#f54e' : '#fff6',
                            borderWidth: x.watching ? 2 : 0,
                        },
                        emphasis: {
                            label: {
                                show: true,
                                fontSize: '0.6em',
                                position: 'top',
                                formatter: markEmphasisLabel,
                            }
                        }
                    };
                }),
            },
        }]});
        //markAnimationDuration = Math.min(1200, markAnimationDuration * 1.3);
    });
    return chart;
}


function constrainZoom(zoom) {
    return Math.max(0.10, Math.min(1.75, zoom));
}


async function createMapCanvas(renderer) {
    const scrollEl = document.querySelector('.map-canvas-scroll');
    const mapEl = document.querySelector('.map-canvas');
    let zoom = 1;
    scrollEl.style.setProperty('--zoom', zoom);
    let zoomAF;
    let zoomDone;
    scrollEl.addEventListener('wheel', ev => {
        if (ev.deltaY) {
            ev.preventDefault();
            zoom = constrainZoom(zoom - ev.deltaY / 2000);
            cancelAnimationFrame(zoomAF);
            zoomAF = requestAnimationFrame(() => {
                if (zoomDone) {
                    clearTimeout(zoomDone);
                } else {
                    scrollEl.classList.add('zooming');
                }
                scrollEl.classList.add('zooming');
                scrollEl.style.setProperty('--zoom', zoom);
                // Lazy re-enable of animations to avoid need for forced paint
                zoomDone = setTimeout(() => {
                    zoomDone = null;
                    scrollEl.classList.remove('zooming');
                }, 50);
            });
        }
    });
    let dragX = 0;
    let dragY = 0;
    let dragAF;
    let pointerEvent1;
    let pointerEvent2;
    scrollEl.addEventListener('pointerdown', ev => {
        console.log(ev);
        if (ev.button !== 0 || (pointerEvent1 && pointerEvent2)) {
            return;
        }
        ev.preventDefault();
        if (pointerEvent1) {
            pointerEvent2 = ev;
            scrollEl.classList.remove('dragging');
            scrollEl.classList.add('zooming');
            return;
        } else {
            pointerEvent1 = ev;
        }
        scrollEl.classList.add('dragging');
        let lastX  = ev.pageX;
        let lastY = ev.pageY;
        const onPointerMove = ev => {
            if (!pointerEvent2) {
                cancelAnimationFrame(dragAF);
                dragAF = requestAnimationFrame(() => {
                    const deltaX = ev.pageX - lastX;
                    const deltaY = ev.pageY - lastY;
                    dragX += 1 / zoom * deltaX;
                    dragY += 1 / zoom * deltaY;
                    lastX = ev.pageX;
                    lastY = ev.pageY;
                    scrollEl.style.setProperty('--drag-x-offt', `${dragX}px`);
                    scrollEl.style.setProperty('--drag-y-offt', `${dragY}px`);
                });
            } else {
                console.log(ev);
                let otherEvent;
                if (ev.pointerId === pointerEvent1.pointerId) {
                    otherEvent = pointerEvent1;
                    pointerEvent1 = ev;
                } else if (ev.pointerId === pointerEvent2.pointerId) {
                    otherEvent = pointerEvent2;
                    pointerEvent2 = ev;
                } else {
                    // third finger, ignore
                    return;
                }
                ev.distance = Math.sqrt((ev.pageX - otherEvent.pageX) ** 2 + (ev.pageY - otherEvent.pageY) ** 2);
                const deltaDistance = ev.distance - (otherEvent.distance || 0);
                console.log('zooming', deltaDistance);
                zoom = constrainZoom(zoom - deltaDistance / 200);
                scrollEl.style.setProperty('--zoom', zoom);
            }
        };
        const onPointerDone = ev => {
            scrollEl.classList.remove(pointerEvent2 ? 'zooming' : 'dragging');
            document.removeEventListener('pointermove', onPointerMove);
            pointerEvent1 = pointerEvent2 = null;
        };
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerDone, {once: true});
        document.addEventListener('pointercancel', onPointerDone, {once: true});
    });
    const dotsEl = mapEl.querySelector('.dots');
    const mapImg = mapEl.querySelector('img');
    let courseId;
    let worldMeta;
    let mapScale;
    let headingRotations = 0;
    let lastHeading = 0;
    const dots = new Map();
    const worldList = await gettingWorldList;
    renderer.addCallback(async nearby => {
        if (!nearby || !nearby.length) {
            return;
        }
        const watching = nearby.find(x => x.watching);
        //watching.state.courseId = 17;
        if (watching.state.courseId !== courseId) {
            scrollEl.classList.add('zooming'); // Disable animation
            courseId = watching.state.courseId;
            worldMeta = worldList.find(x => x.courseId === courseId);
            mapScale = worldMeta.mapScale;
            scrollEl.style.setProperty('--x-offt', `${worldMeta.mapOffsetX}px`);
            scrollEl.style.setProperty('--y-offt', `${worldMeta.mapOffsetY}px`);
            mapImg.src = `https://cdn.zwift.com/static/images/maps/MiniMap_${worldMeta.mapKey}.png`;
            const roads = await common.getRoads(worldMeta.worldId);
            for (const r of Object.values(roads)) {
                continue;
                for (let [x, y] of r.coords) {
                    const dot = document.createElement('div');
                    dot.classList.add('dot', 'watching');
                    dotsEl.append(dot);
                    if (worldMeta.mapRotateHack) {
                        [x, y] = [y, -x];
                    }
                    dot.style.setProperty('--x', `${(x / worldMeta.tileScale) * mapScale}px`);
                    dot.style.setProperty('--y', `${(y / worldMeta.tileScale) * mapScale}px`);
                }
            }
            requestAnimationFrame(() => (scrollEl.offsetWidth, scrollEl.classList.remove('zooming')));
        }
        for (const entry of nearby) {
            if (!dots.has(entry.athleteId)) {
                const dot = document.createElement('div');
                dot.classList.add('dot');
                dot.classList.toggle('watching', !!entry.watching);
                dot.dataset.athleteId = entry.athleteId;
                dotsEl.append(dot);
                dots.set(entry.athleteId, dot);
            }
            const dot = dots.get(entry.athleteId);
            dot.lastSeen = Date.now();
            let x = (entry.state.x / worldMeta.tileScale) * mapScale;
            let y = (entry.state.y / worldMeta.tileScale) * mapScale;
            if (worldMeta.mapRotateHack) {
                [x, y] = [y, -x];
            }
            dot.style.setProperty('--x', `${x}px`);
            dot.style.setProperty('--y', `${y}px`);
            if (entry.watching) {
                mapEl.style.setProperty('--anchor-x', `${x}px`);
                mapEl.style.setProperty('--anchor-y', `${y}px`);
            }
        }
        let heading = watching.state.heading;
        if (Math.abs(lastHeading - heading) > 180) {
            headingRotations += Math.sign(lastHeading - heading);
        }
        console.log(heading, lastHeading - heading, headingRotations, heading + headingRotations * 360);
        mapEl.style.setProperty('--heading', `${heading + headingRotations * 360}deg`);
        lastHeading = heading;
    });
}


export async function main() {
    common.initInteractionListeners();
    const content = document.querySelector('#content');
    const renderer = new common.Renderer(content);
    const elevationProfile = await createElevationProfile(renderer);
    await createMapCanvas(renderer);
    addEventListener('resize', () => {
        elevationProfile.resize();
        renderer.render({force: true});
    });
    common.subscribe('nearby', nearby => {
        renderer.setData(nearby);
        renderer.render();
    });
    renderer.render();
}


export async function settingsMain() {
    common.initInteractionListeners();
    await common.initSettingsForm('form');
}
