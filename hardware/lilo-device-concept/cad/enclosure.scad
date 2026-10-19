// LILO rounded snap-fit station. All dimensions are in millimetres.
part = "assembly";
$fn = 96;
case_d = 144;
case_depth = 72;
wall = 3;
fit = 0.3;
edge_radial = 7;
edge_axial = 12;
face_r = case_d / 2 - edge_radial;
clip_outer = face_r - wall - 0.5;
clip_t = 1.2;
clip_w = 8;
clip_length = 18.2;
display_aperture = 48.3;
display_y = 8;
power_xy = [0, 49];
mute_xy = [-38.27, 33.29];
board_holes_x = 58;
board_holes_y = 49;
board_origin = [-29, -24.5];

function smooth(t) = t * t * (3 - 2 * t);
function radius_at(z) = face_r + edge_radial * smooth(min(1, min(z, case_depth-z) / edge_axial));
function outer_points() = concat([for(i=[0:24]) [radius_at(i*edge_axial/24), i*edge_axial/24]], [[case_d/2,case_depth-edge_axial]], [for(i=[1:24]) [radius_at(case_depth-edge_axial+i*edge_axial/24),case_depth-edge_axial+i*edge_axial/24]]);
module outside() { rotate_extrude() polygon(concat([[0,0]],outer_points(),[[0,case_depth]])); }
module positions() { for(a=[0,90,180,270]) rotate([0,0,a]) children(); }
module receiver() { translate([face_r-wall,-6,0]) cube([edge_radial+wall+1,12,22]); }
module snap_seat() { translate([clip_outer+0.2,-clip_w/2-fit,15.3]) cube([1.6,clip_w+2*fit,3.4]); }
module shell() {
    difference() {
        intersection() {
            outside();
            union() {
                rotate_extrude() polygon(concat(outer_points(),[for(i=[len(outer_points())-1:-1:0]) [outer_points()[i][0]-wall,outer_points()[i][1]]]));
                positions() receiver();
                translate([0,0,case_depth]) mirror([0,0,1]) positions() receiver();
                // Inner board carrier rails, outside the screen and cable path.
                translate([-72,-24,14]) cube([28,12,44]);
                translate([44,-24,14]) cube([28,12,44]);
            }
        }
        for(x=[-48,48]) translate([x-3.4,-20.3,16]) cube([6.8,3.6,58]);
        positions() snap_seat();
        translate([0,0,case_depth]) mirror([0,0,1]) positions() snap_seat();
        // Rear release slots expose the flexible beam, preserving its retaining shoulder.
        positions() translate([clip_outer-0.1,-5,case_depth-12]) cube([20,10,7]);
        // A flat contact patch is part of the body; no separate pedestal.
        translate([-120,-120,-1]) cube([240,120-case_d/2+6,case_depth+2]);
        // Convection openings are real passages near the rear of the enclosure.
        for(x=[-25:10:25]) translate([x-1.5,case_d/2-12,54]) cube([3,18,12]);
    }
}
module latch() {
    translate([clip_outer-clip_t,-clip_w/2,wall]) cube([clip_t,clip_w,clip_length]);
    rotate([90,0,0]) linear_extrude(height=clip_w,center=true)
        polygon([[clip_outer,18.3],[clip_outer+0.9,18.3],[clip_outer+0.9,18.5],[clip_outer,21.2]]);
}
module locating_lip() {
    translate([0,0,wall]) difference() { cylinder(r=face_r-wall-fit,h=2); cylinder(r=face_r-wall-2.5,h=3); }
}
module split_post(height=24,ledge=24.4) {
    difference() {
        union() {
            translate([-3,-2,wall]) cube([6,4,height]);
            translate([-3.4,-2,ledge]) cube([6.8,4,0.8]);
            translate([0,0,ledge+0.8]) linear_extrude(height=1.8,scale=[6/6.8,1]) square([6.8,4],center=true);
        }
        translate([-0.7,-3,5]) cube([1.4,6,height+6]);
    }
}
module front() {
    difference() {
        union() { cylinder(r=face_r,h=wall); locating_lip(); }
        translate([0,display_y,-1]) cylinder(d=display_aperture,h=6);
        translate([power_xy[0],power_xy[1],-1]) cylinder(d=16.2,h=6);
        // Acoustic outlets remain clear of the real round AMOLED module.
        for(y=[-48,-52]) hull() for(x=[-23,23]) translate([x,y,-1]) cylinder(d=2.3,h=6);
    }
    positions() latch();
    for(x=[-31,31],y=[display_y-10,display_y+10]) translate([x,y,0]) split_post(height=9.4,ledge=10.1);
    for(x=[-23,23]) translate([x,-45,0]) split_post(height=32.4,ledge=33.1);
}
module bezel() {
    difference() {
        union() { cylinder(r=26.2,h=0.8); translate([0,0,0.8]) cylinder(r=24.25,h=1.5); }
        translate([0,0,-1]) cylinder(r=22.1,h=4);
        for(a=[0,90,180,270]) rotate([0,0,a]) translate([23,-0.6,0.8]) cube([5,1.2,2]);
    }
}
module audio_post() {
    difference() {
        union() {
            translate([0,0,3]) cylinder(d=3.2,h=7);
            translate([0,0,7.4]) cylinder(d=3.8,h=0.7);
            translate([0,0,8.1]) cylinder(d1=3.8,d2=3.2,h=1.9);
        }
        translate([-0.6,-3,5]) cube([1.2,6,8]);
    }
}
// Integral PETG flexure presses the real mute switch; stop tabs limit travel to 0.6 mm.
module mute_flexure() {
    translate([-mute_xy[0],mute_xy[1],0]) {
        difference() {
            cylinder(d=10,h=0.8);
            translate([0,0,-0.1]) mirror([1,0,0]) linear_extrude(height=0.3)
                text("MIC",size=2,halign="center",valign="center");
        }
        translate([4,-1,0]) cube([10,2,0.8]);
        for(side=[-1,1]) translate([-1.5,side>0?4.5:-7.6,1.4]) cube([3,3.1,1.6]);
    }
}
module rear() {
    difference() {
        union() { cylinder(r=face_r,h=wall); locating_lip(); positions() latch(); }
        // The Pi's native power socket is reached through this alignment window.
        translate([22.3,-12.8,-1]) cube([18,10,6]);
        // Release room for a short flexure above the board's real mute switch.
        translate([-mute_xy[0],mute_xy[1],-1]) cylinder(d=14,h=6);
        translate([-mute_xy[0]+5,mute_xy[1]-2,-1]) cube([8,4,6]);
        for(x=[-37.5,37.5]) translate([x,22,-1]) cylinder(d=3.6,h=6);
        translate([-3,18,-1]) cube([6,8,6]);
        for(x=[-32:8:32]) hull() for(y=[-9,9]) translate([x,y,-1]) cylinder(d=2.6,h=6);
    }
    mute_flexure();
    for(x=[-40,40],y=[5.5,38.5]) translate([x,y,0]) audio_post();
}
module tray() {
    difference() {
        hull() for(x=[-34,54],y=[-24,24]) translate([x,y,0]) cylinder(d=8,h=3);
        translate([-36,-19,-1]) cube([72,38,6]);
    }
    // Board fasteners use its real mounting pattern; the carrier clips into shell rails.
    for(x=[0,board_holes_x],y=[0,board_holes_y]) translate([board_origin[0]+x,board_origin[1]+y,3]) difference() { cylinder(d=7,h=6); cylinder(d=2.5,h=7); }

}
module display_clamp() {
    difference() {
        hull() { cylinder(d=10,h=3); translate([8,0,0]) cylinder(d=8,h=3); }
        translate([-3-fit/2,-2-fit/2,-1]) cube([6+fit,4+fit,5]);
    }
}
module audio_cradle() {
    difference() {
        union() {
            hull() for(x=[2,88],y=[2,37]) translate([x,y,0]) cylinder(r=2,h=2);
            for(y=[0,36.8]) translate([3,y,0]) cube([84,2.2,3]);
            for(x=[15,70],y=[0,36.8]) translate([x,y,2]) cube([8,2.2,2.1]);
            for(x=[15,70]) {
                translate([x,2.0,3.6]) cube([8,0.7,0.5]);
                translate([x,36.3,3.6]) cube([8,0.7,0.5]);
            }
        }
        translate([7,5,-1]) cube([76,29,4]);
        for(x=[5,85],y=[3,36]) translate([x,y,-1]) cylinder(d=3.4,h=4);
    }
}
module speaker_cradle() {
    difference() {
        union() {
            hull() for(x=[2,54.6],y=[2,47]) translate([x,y,0]) cylinder(r=2,h=2);
            for(x=[0,53.6]) translate([x,2,0]) cube([3,45,8]);
            for(y=[8,33]) {
                translate([0,y,8]) cube([1.2,8,19.3]);
                translate([55.4,y,8]) cube([1.2,8,17.3]);
                for(side=[0,1]) translate([side?56.6:0,y+4,0]) scale([side?-1:1,1,1]) rotate([90,0,0]) linear_extrude(height=8,center=true)
                    polygon([[1.2,20.3],[3.8,24.3],[3.8,25],[1.2,27.3]]);
            }
        }
        translate([10,7,-1]) cube([36.6,35,4]);
        for(x=[5.3,51.3]) translate([x-3.15,16.5-2.15,-1]) cube([6.3,4.3,4]);
    }
}
if(part=="shell") shell();
else if(part=="front") front();
else if(part=="rear") rear();
else if(part=="bezel") bezel();
else if(part=="tray") tray();
else if(part=="display_clamp") display_clamp();
else if(part=="audio_cradle") audio_cradle();
else if(part=="speaker_cradle") speaker_cradle();
else if(part=="assembly") {
    color("ivory") shell();
    color("dimgray") translate([0,0,-wall]) front();
    color("mediumpurple") translate([0,display_y,-3.8]) bezel();
    color("gray") translate([-45,2.5,67.835]) audio_cradle();
    color("gray") translate([-28.3,-61.5,28]) speaker_cradle();
    color("ivory") translate([0,0,case_depth+wall]) rotate([0,180,0]) rear();
    color("gray") translate([-10,-20,44]) rotate([-90,0,0]) tray();
    for(x=[-31,31],y=[display_y-10,display_y+10]) color("gray") translate([x,y,4]) rotate([0,0,x>0?180:0]) display_clamp();
} else assert(false,"Unknown enclosure part");
