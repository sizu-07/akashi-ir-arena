#include "../firmware/include/feedback.h"
constexpr bool noReplay(){
 DamageFeedback f;
 if(f.observe(false,10,1000,1000,1000,true,500,300))return false;
 if(f.observe(true,10,1000,1000,1000,true,500,300))return false;
 if(!f.observe(true,11,1100,1100,1100,true,500,300))return false;
 if(f.observe(true,11,1100,1400,1400,true,500,300))return false;
 if(f.observe(true,12,1500,1500,1500,false,500,300))return false;
 if(f.observe(true,12,1500,1550,1550,true,500,300))return false;
 if(f.observe(true,13,1600,2200,2200,true,500,300))return false;
 if(f.observe(true,14,2400,2300,2300,true,500,300))return false;
 return !f.observe(false,20,2400,2400,2400,true,500,300);
}
constexpr bool rateAndWrap(){
 DamageFeedback f;f.observe(false,0,0,0,0,true,500,300);
 if(!f.observe(true,1,1000,1000,0xffffff00u,true,500,300))return false;
 if(f.observe(true,2,1100,1100,0xffffff64u,true,500,300))return false;
 return f.observe(true,3,1400,1400,144u,true,500,300);
}
static_assert(noReplay(),"Retained, duplicate, disabled, stale and future feedback must not replay");
static_assert(rateAndWrap(),"Motor cooldown must survive uint32 millis rollover");
