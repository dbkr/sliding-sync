// This file contains the entry point for the client, as well as DOM interactions.
import {
    SlidingList,
    SlidingSyncConnection,
    SlidingSync,
    LifecycleSyncComplete,
    LifecycleSyncRequestFinished,
} from "./sync.js";
import * as render from "./render.js";
import * as devtools from "./devtools.js";

let slidingSync;
let syncConnection = new SlidingSyncConnection();
let activeLists = [
    new SlidingList("Direct Messages", {
        is_dm: true,
    }),
    new SlidingList("Group Chats", {
        is_dm: false,
    }),
];

// this is the main data structure the client uses to remember and render rooms. Attach it to
// the window to allow easy introspection.
let rooms = {
    // this map is never deleted and forms the persistent storage of the client
    roomIdToRoom: {},
};
window.rooms = rooms;
window.activeLists = activeLists;
const accumulateRoomData = (r, isUpdate) => {
    let room = r;
    if (isUpdate) {
        // use what we already have, if any
        let existingRoom = rooms.roomIdToRoom[r.room_id];
        if (existingRoom) {
            if (r.name) {
                existingRoom.name = r.name;
            }
            if (r.highlight_count !== undefined) {
                existingRoom.highlight_count = r.highlight_count;
            }
            if (r.notification_count !== undefined) {
                existingRoom.notification_count = r.notification_count;
            }
            if (r.timeline) {
                r.timeline.forEach((e) => {
                    existingRoom.timeline.push(e);
                });
            }
            room = existingRoom;
        }
    }
    // pull out avatar and topic if it exists
    let avatar;
    let topic;
    let obsolete;
    if (r.required_state) {
        for (let i = 0; i < r.required_state.length; i++) {
            const ev = r.required_state[i];
            switch (ev.type) {
                case "m.room.avatar":
                    avatar = ev.content.url;
                    break;
                case "m.room.topic":
                    topic = ev.content.topic;
                    break;
                case "m.room.tombstone":
                    obsolete = ev.content.body || "m.room.tombstone";
                    break;
            }
        }
    }
    if (avatar !== undefined) {
        room.avatar = avatar;
    }
    if (topic !== undefined) {
        room.topic = topic;
    }
    if (obsolete !== undefined) {
        room.obsolete = obsolete;
    }
    rooms.roomIdToRoom[room.room_id] = room;
};

let debounceTimeoutId;
let visibleIndexes = {}; // e.g "1-44" meaning list 1 index 44

const intersectionObserver = new IntersectionObserver(
    (entries) => {
        entries.forEach((entry) => {
            let key = entry.target.id.substr("room-".length);
            if (entry.isIntersecting) {
                visibleIndexes[key] = true;
            } else {
                delete visibleIndexes[key];
            }
        });
        // we will process the intersections after a short period of inactivity to not thrash the server
        clearTimeout(debounceTimeoutId);
        debounceTimeoutId = setTimeout(() => {
            let listIndexToStartEnd = {};
            Object.keys(visibleIndexes).forEach((indexes) => {
                // e.g "1-44"
                let [listIndex, roomIndex] = indexes.split("-");
                let i = Number(roomIndex);
                listIndex = Number(listIndex);
                if (!listIndexToStartEnd[listIndex]) {
                    listIndexToStartEnd[listIndex] = {
                        startIndex: -1,
                        endIndex: -1,
                    };
                }
                let startIndex = listIndexToStartEnd[listIndex].startIndex;
                let endIndex = listIndexToStartEnd[listIndex].endIndex;
                if (startIndex === -1 || i < startIndex) {
                    listIndexToStartEnd[listIndex].startIndex = i;
                }
                if (endIndex === -1 || i > endIndex) {
                    listIndexToStartEnd[listIndex].endIndex = i;
                }
            });
            console.log(
                "Intersection indexes:",
                JSON.stringify(listIndexToStartEnd)
            );
            // buffer range
            const bufferRange = 5;

            Object.keys(listIndexToStartEnd).forEach((listIndex) => {
                let startIndex = listIndexToStartEnd[listIndex].startIndex;
                let endIndex = listIndexToStartEnd[listIndex].endIndex;
                startIndex =
                    startIndex - bufferRange < 0 ? 0 : startIndex - bufferRange;
                endIndex =
                    endIndex + bufferRange >= activeLists[listIndex].joinedCount
                        ? activeLists[listIndex].joinedCount - 1
                        : endIndex + bufferRange;

                // we don't need to request rooms between 0,20 as we always have a filter for this
                if (endIndex <= 20) {
                    return;
                }
                // ensure we don't overlap with the 0,20 range
                if (startIndex < 20) {
                    startIndex = 20;
                }

                activeLists[listIndex].activeRanges[1] = [startIndex, endIndex];
            });
            // interrupt the sync connection to send up new ranges
            syncConnection.abort();
        }, 100);
    },
    {
        threshold: [0],
    }
);

const renderMessage = (container, ev) => {
    const eventIdKey = "msg" + ev.event_id;
    // try to find the element. If it exists then don't re-render.
    const existing = document.getElementById(eventIdKey);
    if (existing) {
        return;
    }
    const msgCell = render.renderEvent(eventIdKey, ev);
    container.appendChild(msgCell);
};

const onRoomClick = (e) => {
    let listIndex = -1;
    let index = -1;
    // walk up the pointer event path until we find a room-##-## id=
    const path = e.composedPath();
    for (let i = 0; i < path.length; i++) {
        if (path[i].id && path[i].id.startsWith("room-")) {
            const indexes = path[i].id.substr("room-".length).split("-");
            listIndex = Number(indexes[0]);
            index = Number(indexes[1]);
            break;
        }
    }
    if (index === -1) {
        console.log("failed to find room for onclick");
        return;
    }
    // assign room subscription
    slidingSync.roomSubscription =
        activeLists[listIndex].roomIndexToRoomId[index];
    renderRoomContent(slidingSync.roomSubscription, true);
    // get the highlight on the room
    const roomListElements = document.getElementsByClassName("roomlist");
    for (let i = 0; i < roomListElements.length; i++) {
        renderList(roomListElements[i], i);
    }
    // interrupt the sync to get extra state events
    syncConnection.abort();
};

const renderRoomContent = (roomId, refresh) => {
    if (roomId !== slidingSync.roomSubscription) {
        return;
    }
    const container = document.getElementById("messages");
    if (refresh) {
        document.getElementById("selectedroomname").textContent = "";
        // wipe all message entries
        while (container.hasChildNodes()) {
            container.removeChild(container.firstChild);
        }
    }
    let room = rooms.roomIdToRoom[slidingSync.roomSubscription];
    if (!room) {
        console.error(
            "renderRoomContent: unknown active room ID ",
            slidingSync.roomSubscription
        );
        return;
    }
    document.getElementById("selectedroomname").textContent =
        room.name || room.room_id;
    if (room.avatar) {
        document.getElementById("selectedroomavatar").src =
            mxcToUrl(room.avatar) || "/client/placeholder.svg";
    } else {
        document.getElementById("selectedroomavatar").src =
            "/client/placeholder.svg";
    }
    if (room.topic) {
        document.getElementById("selectedroomtopic").textContent = room.topic;
    } else {
        document.getElementById("selectedroomtopic").textContent = "";
    }

    // insert timeline messages
    (room.timeline || []).forEach((ev) => {
        renderMessage(container, ev);
    });
    if (container.lastChild) {
        container.lastChild.scrollIntoView();
    }
};

const roomIdAttr = (listIndex, roomIndex) => {
    return "room-" + listIndex + "-" + roomIndex;
};

const renderList = (container, listIndex) => {
    const listData = activeLists[listIndex];
    if (!listData) {
        console.error(
            "renderList(): cannot render list at index ",
            listIndex,
            " no data associated with this index!"
        );
        return;
    }
    let addCount = 0;
    let removeCount = 0;
    // ensure we have the right number of children, remove or add appropriately.
    while (container.childElementCount > listData.joinedCount) {
        intersectionObserver.unobserve(container.lastChild);
        container.removeChild(container.lastChild);
        removeCount += 1;
    }
    for (let i = container.childElementCount; i < listData.joinedCount; i++) {
        const template = document.getElementById("roomCellTemplate");
        // https://developer.mozilla.org/en-US/docs/Web/HTML/Element/template#avoiding_documentfragment_pitfall
        const roomCell = template.content.firstElementChild.cloneNode(true);
        roomCell.setAttribute("id", roomIdAttr(listIndex, i));
        container.appendChild(roomCell);
        intersectionObserver.observe(roomCell);
        roomCell.addEventListener("click", onRoomClick);
        addCount += 1;
    }
    if (addCount > 0 || removeCount > 0) {
        console.log(
            "render: added ",
            addCount,
            "nodes, removed",
            removeCount,
            "nodes"
        );
    }
    // loop all elements and modify the contents
    for (let i = 0; i < container.children.length; i++) {
        const roomCell = container.children[i];
        const roomId = listData.roomIndexToRoomId[i];
        const r = rooms.roomIdToRoom[roomId];
        const roomNameSpan = roomCell.getElementsByClassName("roomname")[0];
        const roomContentSpan =
            roomCell.getElementsByClassName("roomcontent")[0];
        const roomSenderSpan = roomCell.getElementsByClassName("roomsender")[0];
        const roomTimestampSpan =
            roomCell.getElementsByClassName("roomtimestamp")[0];
        const unreadCountSpan =
            roomCell.getElementsByClassName("unreadcount")[0];
        unreadCountSpan.textContent = "";
        unreadCountSpan.classList.remove("unreadcountnotify");
        unreadCountSpan.classList.remove("unreadcounthighlight");
        if (!r) {
            // placeholder
            roomNameSpan.textContent = randomName(i, false);
            roomNameSpan.style = "background: #e0e0e0; color: #e0e0e0;";
            roomContentSpan.textContent = randomName(i, true);
            roomContentSpan.style = "background: #e0e0e0; color: #e0e0e0;";
            roomSenderSpan.textContent = "";
            roomTimestampSpan.textContent = "";
            roomCell.getElementsByClassName("roomavatar")[0].src =
                "/client/placeholder.svg";
            roomCell.style = "";
            continue;
        }
        roomCell.style = "";
        roomNameSpan.textContent = r.name || r.room_id;
        roomNameSpan.style = "";
        roomContentSpan.style = "";
        if (r.avatar) {
            roomCell.getElementsByClassName("roomavatar")[0].src =
                mxcToUrl(r.avatar) || "/client/placeholder.svg";
        } else {
            roomCell.getElementsByClassName("roomavatar")[0].src =
                "/client/placeholder.svg";
        }
        if (roomId === slidingSync.roomSubscription) {
            roomCell.style = "background: #d7d7f7";
        }
        if (r.highlight_count > 0) {
            // use the notification count instead to avoid counts dropping down. This matches ele-web
            unreadCountSpan.textContent = r.notification_count + "";
            unreadCountSpan.classList.add("unreadcounthighlight");
        } else if (r.notification_count > 0) {
            unreadCountSpan.textContent = r.notification_count + "";
            unreadCountSpan.classList.add("unreadcountnotify");
        } else {
            unreadCountSpan.textContent = "";
        }

        if (r.obsolete) {
            roomContentSpan.textContent = "";
            roomSenderSpan.textContent = r.obsolete;
        } else if (r.timeline && r.timeline.length > 0) {
            const mostRecentEvent = r.timeline[r.timeline.length - 1];
            roomSenderSpan.textContent = mostRecentEvent.sender;
            // TODO: move to render.js
            roomTimestampSpan.textContent = render.formatTimestamp(
                mostRecentEvent.origin_server_ts
            );

            const body = render.textForEvent(mostRecentEvent);
            if (mostRecentEvent.type === "m.room.member") {
                roomContentSpan.textContent = "";
                roomSenderSpan.textContent = body;
            } else {
                roomContentSpan.textContent = body;
            }
        } else {
            roomContentSpan.textContent = "";
        }
    }
};

const doSyncLoop = async (accessToken) => {
    if (slidingSync) {
        console.log("Terminating old loop");
        slidingSync.stop();
    }
    console.log("Starting sync loop");
    slidingSync = new SlidingSync(activeLists, syncConnection);
    slidingSync.addLifecycleListener((state, resp, err) => {
        switch (state) {
            case LifecycleSyncComplete:
                const roomListElements =
                    document.getElementsByClassName("roomlist");
                for (let i = 0; i < roomListElements.length; i++) {
                    renderList(roomListElements[i], i);
                }

                // check for duplicates and rooms outside tracked ranges which should never happen but can if there's a bug
                activeLists.forEach((list, listIndex) => {
                    let roomIdToPositions = {};
                    let dupeRoomIds = new Set();
                    let indexesOutsideRanges = new Set();
                    Object.keys(list.roomIndexToRoomId).forEach((i) => {
                        let rid = list.roomIndexToRoomId[i];
                        if (!rid) {
                            return;
                        }
                        let positions = roomIdToPositions[rid] || [];
                        positions.push(i);
                        roomIdToPositions[rid] = positions;
                        if (positions.length > 1) {
                            dupeRoomIds.add(rid);
                        }
                        let isInsideRange = false;
                        list.activeRanges.forEach((r) => {
                            if (i >= r[0] && i <= r[1]) {
                                isInsideRange = true;
                            }
                        });
                        if (!isInsideRange) {
                            indexesOutsideRanges.add(i);
                        }
                    });
                    dupeRoomIds.forEach((rid) => {
                        console.log(
                            rid,
                            "in list",
                            listIndex,
                            "has duplicate indexes:",
                            roomIdToPositions[rid]
                        );
                    });
                    if (indexesOutsideRanges.size > 0) {
                        console.log(
                            "list",
                            listIndex,
                            "tracking indexes outside of tracked ranges:",
                            JSON.stringify([...indexesOutsideRanges])
                        );
                    }
                });

                devtools.svgify(
                    document.getElementById("listgraph"),
                    activeLists,
                    resp
                );
                break;
            case LifecycleSyncRequestFinished:
                if (err) {
                    console.error("/sync failed:", err);
                    document.getElementById("errorMsg").textContent = err;
                } else {
                    document.getElementById("errorMsg").textContent = "";
                }
                break;
        }
    });
    slidingSync.addRoomDataListener((roomId, roomData, isIncremental) => {
        accumulateRoomData(
            roomData,
            isIncremental
                ? isIncremental
                : rooms.roomIdToRoom[roomId] !== undefined
        );
        renderRoomContent(roomId);
    });
    slidingSync.start(accessToken);
};

const randomName = (i, long) => {
    if (i % 17 === 0) {
        return long
            ? "Ever have that feeling where you’re not sure if you’re awake or dreaming?"
            : "There is no spoon";
    } else if (i % 13 === 0) {
        return long
            ? "Choice is an illusion created between those with power and those without."
            : "Get Up Trinity";
    } else if (i % 11 === 0) {
        return long
            ? "That’s how it is with people. Nobody cares how it works as long as it works."
            : "I know kung fu";
    } else if (i % 7 === 0) {
        return long
            ? "The body cannot live without the mind."
            : "Free your mind";
    } else if (i % 5 === 0) {
        return long
            ? "Perhaps we are asking the wrong questions…"
            : "Agent Smith";
    } else if (i % 3 === 0) {
        return long
            ? "You've been living in a dream world, Neo."
            : "Mr Anderson";
    } else {
        return long ? "Mr. Wizard, get me the hell out of here! " : "Morpheus";
    }
};

const mxcToUrl = (mxc) => {
    const path = mxc.substr("mxc://".length);
    if (!path) {
        return;
    }
    // TODO: we should really use the proxy HS not matrix.org
    return `https://matrix-client.matrix.org/_matrix/media/r0/thumbnail/${path}?width=64&height=64&method=crop`;
};

window.addEventListener("load", (event) => {
    const container = document.getElementById("roomlistcontainer");
    activeLists.forEach((list) => {
        const roomList = document.createElement("div");
        roomList.className = "roomlist";
        const roomListName = document.createElement("div");
        roomListName.className = "roomlistname";
        roomListName.textContent = list.name;
        const roomListWrapper = document.createElement("div");
        roomListWrapper.className = "roomlistwrapper";
        roomListWrapper.appendChild(roomListName);
        roomListWrapper.appendChild(roomList);
        container.appendChild(roomListWrapper);
    });
    const storedAccessToken = window.localStorage.getItem("accessToken");
    if (storedAccessToken) {
        document.getElementById("accessToken").value = storedAccessToken;
    }
    document.getElementById("syncButton").onclick = () => {
        const accessToken = document.getElementById("accessToken").value;
        window.localStorage.setItem("accessToken", accessToken);
        doSyncLoop(accessToken);
    };
    document.getElementById("roomfilter").addEventListener("input", (ev) => {
        const roomNameFilter = ev.target.value;
        for (let i = 0; i < activeLists.length; i++) {
            const filters = activeLists[i].getFilters();
            filters.room_name_like = roomNameFilter;
            activeLists[i].setFilters(filters);
        }
        // bump to the start of the room list again
        const lists = document.getElementsByClassName("roomlist");
        for (let i = 0; i < lists.length; i++) {
            if (lists[i].firstChild) {
                lists[i].firstChild.scrollIntoView(true);
            }
        }
        // interrupt the sync request to send up new filters
        syncConnection.abort();
    });
});
