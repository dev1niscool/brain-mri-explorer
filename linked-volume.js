/** Native-grid display NIfTI sampling for linked, axis-aligned RAS views.
 * This module has no DOM dependencies and never constructs a resampled 3D volume.
 * Affine matrices are flat, row-major 4×4 arrays; world distances are millimetres.
 */
const MAX_NATIVE_VOXELS=134217728;
const BOUNDARY_EPSILON=1e-6;

export function invertAffine(matrix) {
  if(!matrix||matrix.length!==16||!Array.from(matrix).every(Number.isFinite)||matrix[12]!==0||matrix[13]!==0||matrix[14]!==0||matrix[15]!==1)throw new Error('The MRI affine matrix is invalid.');
  const [a,b,c,t,d,e,f,u,g,h,i,v]=matrix;
  const cofactors=[e*i-f*h,c*h-b*i,b*f-c*e,f*g-d*i,a*i-c*g,c*d-a*f,d*h-e*g,b*g-a*h,a*e-b*d];
  const determinant=a*cofactors[0]+b*cofactors[3]+c*cofactors[6];
  const normProduct=Math.hypot(a,d,g)*Math.hypot(b,e,h)*Math.hypot(c,f,i);
  if(!Number.isFinite(determinant)||!normProduct||Math.abs(determinant)<=normProduct*1e-12)throw new Error('The MRI affine matrix is singular.');
  const r=cofactors.map(value=>value/determinant);
  return [r[0],r[1],r[2],-(r[0]*t+r[1]*u+r[2]*v),
          r[3],r[4],r[5],-(r[3]*t+r[4]*u+r[5]*v),
          r[6],r[7],r[8],-(r[6]*t+r[7]*u+r[8]*v),0,0,0,1];
}

/** Accept the precise public dataset format; reject unsupported files visibly. */
export function parseNativeNifti(buffer) {
  if(!(buffer instanceof ArrayBuffer)||buffer.byteLength<352)throw new Error('The native MRI header is incomplete.');
  const header=new DataView(buffer);
  if(header.getInt32(0,true)!==348)throw new Error('The native MRI must be little-endian NIfTI-1.');
  if(header.getUint8(344)!==110||header.getUint8(345)!==43||header.getUint8(346)!==49||header.getUint8(347)!==0)throw new Error('The native MRI must use a single-file NIfTI-1 header.');
  if(header.getInt16(40,true)!==3)throw new Error('The native MRI must contain one three-dimensional volume.');
  const dims=[42,44,46].map(offset=>header.getInt16(offset,true));
  if(dims.some(value=>value<2||value>1024)||dims.reduce((a,b)=>a*b,1)>MAX_NATIVE_VOXELS)throw new Error('The native MRI dimensions are invalid.');
  for(const offset of [48,50,52,54])if(header.getInt16(offset,true)!==1)throw new Error('The native MRI has unsupported extra dimensions.');
  const datatype=header.getInt16(70,true),bits=header.getInt16(72,true);
  if(!((datatype===2&&bits===8)||(datatype===16&&bits===32)))throw new Error('The MRI must contain uint8 display values or float32 intensity samples.');
  if(header.getFloat32(108,true)!==352||[348,349,350,351].some(offset=>header.getUint8(offset)!==0))throw new Error('The native MRI has an unsupported data offset or extension.');
  if(header.getFloat32(112,true)!==1||header.getFloat32(116,true)!==0)throw new Error('The native MRI has unsupported intensity scaling.');
  if((header.getUint8(123)&7)!==2)throw new Error('The native MRI spatial units must be millimetres.');
  if(header.getInt16(254,true)<1||header.getInt16(254,true)>5)throw new Error('The native MRI needs a valid sform transform.');
  const affine=Array.from({length:12},(_,index)=>header.getFloat32(280+index*4,true)).concat([0,0,0,1]);
  const inverseAffine=invertAffine(affine);
  for(let axis=0;axis<3;axis++) {
    const declared=header.getFloat32(80+axis*4,true);
    const actual=Math.hypot(affine[axis],affine[4+axis],affine[8+axis]);
    if(!Number.isFinite(declared)||declared<=0||Math.abs(actual-declared)>Math.max(.001,declared*.001))throw new Error('The native MRI spacing disagrees with its sform.');
  }
  const count=dims.reduce((a,b)=>a*b,1);
  if(buffer.byteLength!==352+count*(bits/8))throw new Error('The native MRI download has an unexpected size.');
  const data=datatype===2?new Uint8Array(buffer,352,count):new Float32Array(buffer,352,count);
  if(datatype===16)for(let index=0;index<data.length;index++)if(!Number.isFinite(data[index]))throw new Error('The native MRI contains invalid intensity samples.');
  return {data,dims,affine,inverseAffine,datatype};
}

/** A virtual sampling grid, matching nibabel's transformed voxel-center bounds. */
export function createLinkedGrid(volume,spacing=.5) {
  if(!Number.isFinite(spacing)||spacing<=0)throw new Error('Linked-view spacing must be positive.');
  const origin=[Infinity,Infinity,Infinity],maximum=[-Infinity,-Infinity,-Infinity],a=volume.affine;
  for(const x of [0,volume.dims[0]-1])for(const y of [0,volume.dims[1]-1])for(const z of [0,volume.dims[2]-1]) {
    for(let row=0;row<3;row++) {
      const offset=row*4,value=a[offset]*x+a[offset+1]*y+a[offset+2]*z+a[offset+3];
      origin[row]=Math.min(origin[row],value);maximum[row]=Math.max(maximum[row],value);
    }
  }
  const dims=maximum.map((value,axis)=>Math.ceil((value-origin[axis])/spacing)+1);
  if(dims.some(value=>!Number.isSafeInteger(value)||value<2||value>1048576))throw new Error('The linked-view grid dimensions are invalid.');
  return {dims,spacing:[spacing,spacing,spacing],origin};
}

// NaN is an internal outside-volume sentinel. It keeps background black even
// when the brightness/window would map a real zero-valued voxel to gray.
function sampleVoxel(data,nx,ny,nz,x,y,z) {
  if(x < -BOUNDARY_EPSILON||y < -BOUNDARY_EPSILON||z < -BOUNDARY_EPSILON||x>nx-1+BOUNDARY_EPSILON||y>ny-1+BOUNDARY_EPSILON||z>nz-1+BOUNDARY_EPSILON)return NaN;
  x=Math.max(0,Math.min(nx-1,x));y=Math.max(0,Math.min(ny-1,y));z=Math.max(0,Math.min(nz-1,z));
  const x0=Math.floor(x),y0=Math.floor(y),z0=Math.floor(z);
  const x1=Math.min(nx-1,x0+1),y1=Math.min(ny-1,y0+1),z1=Math.min(nz-1,z0+1);
  const dx=x-x0,dy=y-y0,dz=z-z0,stride=nx*ny;
  const p00=nx*y0+stride*z0,p10=nx*y1+stride*z0,p01=nx*y0+stride*z1,p11=nx*y1+stride*z1;
  const q00=data[p00+x0]*(1-dx)+data[p00+x1]*dx,q10=data[p10+x0]*(1-dx)+data[p10+x1]*dx;
  const q01=data[p01+x0]*(1-dx)+data[p01+x1]*dx,q11=data[p11+x0]*(1-dx)+data[p11+x1]*dx;
  return (q00*(1-dy)+q10*dy)*(1-dz)+(q01*(1-dy)+q11*dy)*dz;
}

export function sampleWorld(volume,world) {
  if(!world||world.length!==3||!Array.from(world).every(Number.isFinite))throw new Error('The sample position is invalid.');
  const a=volume.inverseAffine,[x,y,z]=world,[nx,ny,nz]=volume.dims;
  const value=sampleVoxel(volume.data,nx,ny,nz,a[0]*x+a[1]*y+a[2]*z+a[3],a[4]*x+a[5]*y+a[6]*z+a[7],a[8]*x+a[9]*y+a[10]*z+a[11]);
  return Number.isNaN(value)?0:value;
}

/** Reformat directly from native-grid display samples, with one intensity mapping.
 * Cursor is in virtual-grid voxel-center coordinates. Plane has axis/u/v.
 * All display data axes are reversed to match the existing linked view.
 */
export function renderLinkedPlane(volume,grid,cursor,plane,width,height,options={}) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>4096||height>4096)throw new Error('The linked image dimensions are invalid.');
  const axes=[plane.axis,plane.u,plane.v];
  if(axes.some(value=>!Number.isInteger(value)||value<0||value>2)||new Set(axes).size!==3)throw new Error('The linked image axes are invalid.');
  if(!cursor||cursor.length!==3||cursor.some((value,axis)=>!Number.isFinite(value)||value<0||value>grid.dims[axis]-1))throw new Error('The linked cursor is outside its grid.');
  const [low,high]=options.window||[0,255],contrast=options.contrast??1,brightness=options.brightness??0,palette=options.palette??'gray';
  if(!Number.isFinite(low)||!Number.isFinite(high)||high<=low||!Number.isFinite(contrast)||contrast<=0||!Number.isFinite(brightness)||!['gray','amber'].includes(palette))throw new Error('The linked intensity window is invalid.');
  const rgba=new Uint8ClampedArray(width*height*4),a=volume.inverseAffine,[nx,ny,nz]=volume.dims;
  const start=grid.origin.map((value,axis)=>value+cursor[axis]*grid.spacing[axis]);
  start[plane.u]=grid.origin[plane.u]+(grid.dims[plane.u]-.5-.5*grid.dims[plane.u]/width)*grid.spacing[plane.u];
  start[plane.v]=grid.origin[plane.v]+(grid.dims[plane.v]-.5-.5*grid.dims[plane.v]/height)*grid.spacing[plane.v];
  const du=-grid.dims[plane.u]*grid.spacing[plane.u]/width,dv=-grid.dims[plane.v]*grid.spacing[plane.v]/height;
  const sx=a[0]*start[0]+a[1]*start[1]+a[2]*start[2]+a[3];
  const sy=a[4]*start[0]+a[5]*start[1]+a[6]*start[2]+a[7];
  const sz=a[8]*start[0]+a[9]*start[1]+a[10]*start[2]+a[11];
  const ux=a[plane.u]*du,uy=a[4+plane.u]*du,uz=a[8+plane.u]*du;
  const vx=a[plane.v]*dv,vy=a[4+plane.v]*dv,vz=a[8+plane.v]*dv;
  const scale=255*contrast/(high-low),offset=127.5*(1-contrast)+brightness-low*scale;
  const green=palette==='amber'?.75:1,blue=palette==='amber'?.36:1;
  let pixel=0;
  for(let row=0;row<height;row++) {
    let x=sx+row*vx,y=sy+row*vy,z=sz+row*vz;
    for(let column=0;column<width;column++,x+=ux,y+=uy,z+=uz) {
      const sample=sampleVoxel(volume.data,nx,ny,nz,x,y,z);
      const intensity=Number.isNaN(sample)?0:Math.max(0,Math.min(255,sample*scale+offset));
      rgba[pixel++]=intensity;rgba[pixel++]=intensity*green;rgba[pixel++]=intensity*blue;rgba[pixel++]=255;
    }
  }
  return rgba;
}
